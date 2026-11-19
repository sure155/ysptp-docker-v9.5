#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ysp-live-lite —— 央视频直播网关 · VPS / Docker 低码精简版

基于 Gary's Club 的 ysp-live 9.8 改造（非作者发布，由使用者自行改造）：
  * 移除：高码率 / 4K / 8K 设备协议（设备注册、AES-GCM / RSA 会话、心跳、并发池）
  * 移除：Node.js「Web WASM 伴生引擎」及 /engine_proxy
  * 保留：低码率路径（JCE 滚动窗口 → bkliveinfo 备用）、时移回看入口、限流退避、
          空闲停止后台轮询、换台不额外请求等原有调度
  * 新增：访问口令（路径前缀）、对外地址覆盖、可选分片中转、/healthz、优雅退出

纯 Python 标准库，无第三方依赖，无需持久化目录。

环境变量：
  YSP_TOKEN             访问口令（强烈建议设置，8~64 位 A-Za-z0-9_-）；设置后所有地址形如 /<TOKEN>/all.m3u
  YSP_PUBLIC_URL        对外访问的基础地址，如 https://tv.example.com（反代 / 域名场景）
  YSP_PROXY_SEGMENTS    1=分片经 VPS 中转（客户端无法直连 CDN / 需要 https 时用），默认 0=客户端直连 CDN
  YSP_CACHE_MB          中转模式下的分片内存缓存，默认 64
  YSP_SEG_ALLOW_EXTRA   中转模式额外允许的 CDN 域名后缀，逗号分隔，如 .foo.com,.bar.net
  YSP_EXCLUDE_CHANNELS  不对外提供的频道 slug，逗号分隔，如 cctv4k,cctv8k,cctv164k
  YSP_PORT / YSP_BIND   监听端口 / 地址（默认 8767 / 0.0.0.0；填 :: 则监听 IPv6 双栈）
"""
from __future__ import annotations

import argparse
import base64
import collections
import datetime
import gzip
import hmac
import http.client
import json
import math
import os
import random
import re
import signal
import socket
import ssl
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

__version__ = 'lite-1.2 (based on ysp-live 9.8)'
AUTHOR_COMMUNITY = 'https://t.me/garysclub'
AUTHOR_CHANNEL = 'https://t.me/garysclubchannel'


# ===================== 配置（环境变量） =====================
def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None or not v.strip():
        return default
    return v.strip().lower() in ('1', 'true', 'yes', 'on')


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(os.environ.get(name, '').strip() or default)
    except ValueError:
        return default
    return max(lo, min(hi, v))


def _env_list(name: str) -> list:
    return [x.strip().lower() for x in os.environ.get(name, '').split(',') if x.strip()]


TOKEN = os.environ.get('YSP_TOKEN', '').strip()
PUBLIC_URL = os.environ.get('YSP_PUBLIC_URL', '').strip().rstrip('/')
PROXY_SEGMENTS = _env_bool('YSP_PROXY_SEGMENTS', False)
CACHE_MB = _env_int('YSP_CACHE_MB', 64, 0, 2048)
SEG_ALLOW_EXTRA = tuple(s if s.startswith('.') else '.' + s for s in _env_list('YSP_SEG_ALLOW_EXTRA'))
EXCLUDE_CHANNELS = set(_env_list('YSP_EXCLUDE_CHANNELS'))
PRIMARY_MODE = os.environ.get('YSP_PRIMARY_MODE', 'bk').strip().lower()
if PRIMARY_MODE not in ('bk', 'jce'):
    PRIMARY_MODE = 'bk'
UPSTREAM_PROXY = os.environ.get('YSP_UPSTREAM_PROXY', '').strip()
FORCE_IPV4 = _env_bool('YSP_FORCE_IPV4', False)

if UPSTREAM_PROXY:
    urllib.request.install_opener(urllib.request.build_opener(
        urllib.request.ProxyHandler({'http': UPSTREAM_PROXY, 'https': UPSTREAM_PROXY})))
else:
    # 默认不读取 HTTP(S)_PROXY 等环境代理，保持与原版一致
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))

if FORCE_IPV4:
    _orig_getaddrinfo = socket.getaddrinfo
    def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        if family in (0, socket.AF_UNSPEC):
            family = socket.AF_INET
        return _orig_getaddrinfo(host, port, family, type, proto, flags)
    socket.getaddrinfo = _ipv4_getaddrinfo

server_port: int = 8767
server_start_time = time.time()



# ======================================================================
#  以下为原版低码率路径（JCE 滚动窗口 / bkliveinfo 备用 / 频道调度），逻辑保持不变
# ======================================================================

global_log_ring = collections.deque(maxlen=120)

_log_lock = threading.Lock()

_last_log_times = {}

def log(msg, min_interval=0.0):
    now = time.time()
    clean_msg = str(msg).strip()
    if not clean_msg:
        return
    with _log_lock:
        interval = min_interval if min_interval > 0.0 else 1.5
        last_t = _last_log_times.get(clean_msg, 0.0)
        if now - last_t < interval:
            return
        _last_log_times[clean_msg] = now
        if len(_last_log_times) > 600:
            _last_log_times.clear()
        line = '[%s] %s' % (time.strftime('%H:%M:%S'), clean_msg)
        global_log_ring.append(line)
    print(line, flush=True)

def normalize_channel(raw: str) -> str:
    key = raw.strip().strip('/').lower()
    if key.endswith('.m3u8'):
        key = key[:-len('.m3u8')]
    if key in ('cctv16-4k', 'cctv16_4k', 'cctv16/4k', 'cctv16(4k)'):
        return 'cctv164k'
    return key

class W:

    def __init__(self):
        self.b = bytearray()

    def head(self, typ, tag):
        if tag < 15:
            self.b.append((tag & 15) << 4 | typ & 15)
        else:
            self.b.append(240 | typ & 15)
            self.b.append(tag)

    def byte(self, v, tag):
        v = int(v)
        if v == 0:
            self.head(12, tag)
        else:
            self.head(0, tag)
            self.b += struct.pack('>b', v)

    def short(self, v, tag):
        v = int(v)
        if -128 <= v <= 127:
            self.byte(v, tag)
        else:
            self.head(1, tag)
            self.b += struct.pack('>h', v)

    def int(self, v, tag):
        v = int(v)
        if -32768 <= v <= 32767:
            self.short(v, tag)
        else:
            self.head(2, tag)
            self.b += struct.pack('>i', v)

    def long(self, v, tag):
        v = int(v)
        if -2147483648 <= v <= 2147483647:
            self.int(v, tag)
        else:
            self.head(3, tag)
            self.b += struct.pack('>q', v)

    def float(self, v, tag):
        self.head(4, tag)
        self.b += struct.pack('>f', float(v))

    def double(self, v, tag):
        self.head(5, tag)
        self.b += struct.pack('>d', float(v))

    def string(self, s, tag):
        if s is None:
            return
        data = str(s).encode('utf-8')
        if len(data) > 255:
            self.head(7, tag)
            self.b += struct.pack('>i', len(data))
            self.b += data
        else:
            self.head(6, tag)
            self.b.append(len(data))
            self.b += data

    def bytes(self, data, tag):
        data = bytes(data)
        self.head(13, tag)
        self.head(0, 0)
        self.int(len(data), 0)
        self.b += data

    def struct(self, fn, tag):
        self.head(10, tag)
        fn(self)
        self.head(11, 0)

    def list(self, items, tag, wf):
        self.head(9, tag)
        self.int(len(items), 0)
        if wf is not None:
            for item in items:
                wf(self, item)

    def out(self):
        return bytes(self.b)

class R:

    def __init__(self, data):
        self.d = memoryview(data)
        self.p = 0

    def rem(self):
        return len(self.d) - self.p

    def get(self, n):
        if self.p + n > len(self.d):
            raise EOFError
        b = self.d[self.p:self.p + n].tobytes()
        self.p += n
        return b

    def u8(self):
        return self.get(1)[0]

    def head(self):
        b = self.u8()
        typ = b & 15
        tag = (b & 240) >> 4
        if tag == 15:
            tag = self.u8()
        return (typ, tag)

    def value(self, typ):
        if typ == 0:
            return struct.unpack('>b', self.get(1))[0]
        if typ == 1:
            return struct.unpack('>h', self.get(2))[0]
        if typ == 2:
            return struct.unpack('>i', self.get(4))[0]
        if typ == 3:
            return struct.unpack('>q', self.get(8))[0]
        if typ == 4:
            return struct.unpack('>f', self.get(4))[0]
        if typ == 5:
            return struct.unpack('>d', self.get(8))[0]
        if typ == 6:
            n = self.u8()
            return self.get(n).decode('utf-8', 'replace')
        if typ == 7:
            n = struct.unpack('>i', self.get(4))[0]
            return self.get(n).decode('utf-8', 'replace')
        if typ == 8:
            n = self._int()
            return {self._fv(): self._fv() for _ in range(n)}
        if typ == 9:
            n = self._int()
            return [self._fv() for _ in range(n)]
        if typ == 10:
            return self.struct()
        if typ == 11:
            return None
        if typ == 12:
            return 0
        if typ == 13:
            t, _ = self.head()
            n = self._int()
            return self.get(n)
        raise ValueError('type %d' % typ)

    def _fv(self):
        t, _ = self.head()
        return self.value(t)

    def _int(self):
        t, _ = self.head()
        return int(self.value(t))

    def struct(self):
        m = {}
        while self.rem() > 0:
            t, tag = self.head()
            if t == 11:
                break
            m[tag] = self.value(t)
        return m

VER_NAME, VER_CODE = ('3.2.7.26212', '302070')

APP_ID, QMF_APP_ID, QMF_PLATFORM, BIZ_ID = ('1200013', 10012, 1, 0)

CHAN_ID = '10070'

GUID = ''.join((random.choice('0123456789abcdef') for _ in range(32)))

def _qua(w):
    w.string(VER_NAME, 0)
    w.string(VER_CODE, 1)
    w.int(1080, 2)
    w.int(2400, 3)
    w.int(3, 4)
    w.string('12', 5)
    w.int(1, 6)
    w.int(1, 7)
    w.int(420, 8)
    w.string(CHAN_ID, 9)
    for i in range(10, 15):
        w.string('', i)
    w.struct(lambda ww: (ww.int(0, 0), ww.byte(0, 1), ww.string('', 2)), 15)
    w.string('', 16)
    w.string('', 17)
    w.string('', 18)
    w.struct(lambda ww: (ww.int(0, 0), ww.float(0, 1), ww.float(0, 2), ww.double(0, 3)), 19)
    w.string(GUID[:16], 20)
    w.string('Pixel 6', 21)
    w.int(1, 22)
    for i in range(23, 27):
        w.int(0, i)
    w.string('', 27)
    w.string('', 28)
    w.string(GUID, 29)

def _head(w, cmd, reqid):
    w.int(reqid, 0)
    w.int(cmd, 1)
    w.struct(lambda ww: _qua(ww), 2)
    w.string(APP_ID, 3)
    w.string(GUID, 4)
    w.list([], 5, None)
    w.struct(lambda ww: None, 6)
    w.list([], 7, None)
    w.int(0, 8)
    w.int(0, 9)
    w.int(0, 10)

def _wrap(cmd, body, reqid):
    w = W()
    w.struct(lambda ww: _head(ww, cmd, reqid), 0)
    w.bytes(body, 1)
    reqcmd = w.out()
    inner = bytearray([38]) + struct.pack('>i', len(reqcmd) + 17) + bytes([1]) + b'\x00' * 10 + reqcmd + bytes([40])
    comp = gzip.compress(bytes(inner))
    out = bytearray([19]) + struct.pack('>i', 0) + struct.pack('>H', 2) + struct.pack('>H', 65281)
    out += struct.pack('>H', cmd) + struct.pack('>H', 0) + struct.pack('>q', reqid)
    out += struct.pack('>i', 531) + struct.pack('>i', QMF_APP_ID) + struct.pack('>q', BIZ_ID)
    g = GUID.encode()[:32]
    out += g + b'\x00' * (32 - len(g))
    out += struct.pack('>b', QMF_PLATFORM) + struct.pack('>i', int(VER_CODE)) + b'\x00' * 6
    out += bytes([0]) + struct.pack('>H', 0) + struct.pack('>H', 0)
    out += struct.pack('>i', len(inner)) + comp + bytes([3])
    struct.pack_into('>i', out, 1, len(out))
    return bytes(out)

def _unwrap(data):
    if data[:1] != b'\x13' or len(data) < 90:
        return None
    flags = struct.unpack('>i', data[21:25])[0]
    payload = data[89:-1]
    if flags & 2:
        payload = gzip.decompress(payload)
    if payload[:1] != b'&' or payload[-1:] != b'(':
        return None
    rc = R(payload[16:-1]).struct()
    return rc.get(1) or b''

class DeadHostError(RuntimeError):
    pass

class JceRateLimited(RuntimeError):
    pass

class JceRequestGate:
    """Serialize JCE requests; honour upstream throttling across all channels."""

    def __init__(self, clock=time.monotonic, sleep=time.sleep):
        self.lock = threading.Lock()
        self.clock, self.sleep = (clock, sleep)
        self.next_request = 0.0
        self.blocked_until = 0.0
        self.penalty = 0.0

    def remaining(self):
        return max(0.0, self.blocked_until - self.clock())

    def throttle(self, retry_after=None):
        self.penalty = min(900.0, max(60.0, self.penalty * 2.0))
        delay = self.penalty
        if retry_after:
            try:
                delay = max(delay, float(retry_after))
            except (ValueError, TypeError):
                try:
                    from email.utils import parsedate_to_datetime
                    delay = max(delay, parsedate_to_datetime(retry_after).timestamp() - time.time())
                except (ValueError, TypeError, OverflowError):
                    pass
        if not math.isfinite(delay):
            delay = self.penalty
        self.blocked_until = max(self.blocked_until, self.clock() + delay)
        return JceRateLimited('JCE 请求已限流，暂停 %.0f 秒后再试' % self.remaining())

    def call(self, fn, active=None):
        with self.lock:
            if self.remaining() > 0:
                raise JceRateLimited('JCE 限流冷却中，剩余 %.0f 秒' % self.remaining())
            delay = self.next_request - self.clock()
            if delay > 0:
                self.sleep(delay)
            if active is not None and (not active()):
                raise RuntimeError('低码率频道已空闲，取消排队请求')
            self.next_request = self.clock() + 2.0
            try:
                result = fn()
            except urllib.error.HTTPError as exc:
                if exc.code == 429:
                    raise self.throttle(exc.headers.get('Retry-After') if exc.headers else None) from exc
                raise
            except RuntimeError as exc:
                message = str(exc).lower()
                if any((mark in message for mark in ('操作过于频繁', '请求过于频繁', 'too many requests', 'rate limit'))):
                    raise self.throttle() from exc
                raise
            self.penalty = 0.0
            return result

jce_request_gate = JceRequestGate()

def jce_timeshift_url(pid, sid, start, end, stream='fhd', active=None):
    return jce_request_gate.call(lambda: _jce_timeshift_url(pid, sid, start, end, stream), active)

def _jce_timeshift_url(pid, sid, start, end, stream='fhd'):
    w = W()
    w.string(pid, 0)
    w.string(sid, 1)
    w.long(start, 2)
    w.long(end, 3)
    w.string(stream, 4)
    body = w.out()
    CMD = 25312
    reqid = int(time.time() * 1000) & 2147483647
    packet = _wrap(CMD, body, reqid)
    req = urllib.request.Request('https://jacc.ysp.cctv.cn', data=packet, method='POST')
    req.add_header('Content-Type', 'application/octet-stream')
    with urllib.request.urlopen(req, timeout=8) as resp:
        raw = resp.read()
    resp_body = _unwrap(raw)
    if not resp_body:
        raise RuntimeError('bad response')
    m = R(resp_body).struct()
    err = m.get(0, 0)
    if err != 0:
        raise RuntimeError(m.get(1, 'errCode=%s' % err))
    url = m.get(2, '')
    if not url:
        raise RuntimeError('empty m3u8')
    if 'liverecord.video.cloud.cctv.com' in url:
        raise DeadHostError('dead cdn host')
    return url

_CK_PLATFORM = 4330403

_CK_APPVER = 'V8.22.1035.3031'

_CK_TEA = bytes.fromhex('59b2f7cf725ef43c34fdd7c123411ed3')

_CK_GTEA = bytes.fromhex('110DBEC10C23E7D2E56A1CAD6914EF1B')

_CK_XOR = bytes([132, 46, 237, 8, 240, 102, 230, 234, 72, 180, 202, 169, 145, 237, 111, 243])

_CK_GXOR = bytes([179, 201, 83, 160, 105, 19, 173, 77])

def _u32(v):
    return v & 4294967295

def _tea_blk(blk, key):
    y, z = struct.unpack('>2I', blk)
    k = struct.unpack('>4I', key)
    s = 0
    for _ in range(16):
        s = _u32(s + 2654435769)
        y = _u32(y + _u32(_u32(_u32(z << 4) + k[0]) ^ _u32(z + s) ^ _u32((z >> 5) + k[1])))
        z = _u32(z + _u32(_u32(_u32(y << 4) + k[2]) ^ _u32(y + s) ^ _u32((y >> 5) + k[3])))
    return struct.pack('>2I', y, z)

def _cksum(buf):
    v = 0
    for b in buf:
        v = 131 * v + b & 2147483647
    return v

def _tea_pkt(data, key):
    pad = (8 - (len(data) + 10) % 8) % 8
    plain = bytes([os.urandom(1)[0] & 248 | pad]) + os.urandom(pad) + os.urandom(2) + data + bytes(7)
    out, pp, pc = (b'', bytes(8), bytes(8))
    for off in range(0, len(plain), 8):
        mixed = bytes((a ^ b for a, b in zip(plain[off:off + 8], pc)))
        enc = _tea_blk(mixed, key)
        cipher = bytes((a ^ b for a, b in zip(enc, pp)))
        out += cipher
        pp, pc = (mixed, cipher)
    return out

def _lp(s):
    d = s.encode() if isinstance(s, str) else s
    return struct.pack('>H', len(d)) + d

def _ck_guard(ts, guid):

    def tail(v):
        t = str(v)
        return t[-5:] if len(t) >= 5 else ''
    body = struct.pack('>I', ts) + _lp(tail(guid)) + _lp(tail('null')) + _lp(tail('null')) + _lp('-1')
    plain = _lp(body)
    enc = _tea_pkt(plain, _CK_GTEA) + struct.pack('>I', _cksum(plain))
    enc = bytes((a ^ _CK_GXOR[i & 7] for i, a in enumerate(enc)))
    return enc.hex().upper()

def _ckey(channel_id):
    ts = int(time.time())
    guid = os.urandom(16).hex()
    guard = _ck_guard(ts, guid)
    uid = os.urandom(4).hex().upper()
    body = bytes.fromhex('0000004200000004000004d2') + struct.pack('>I', _CK_PLATFORM) + struct.pack('>I', 0) + struct.pack('>I', ts) + _lp('dcgh') + _lp('_zj1A5Gh6QYcxWjIUGos2w==') + _lp(_CK_APPVER) + _lp(str(channel_id)) + _lp(guid) + struct.pack('>I', 1) + struct.pack('>I', 1) + _lp(uid) + _lp('nil') + _lp('57eab0c4-2c58-44c6-8ae9-dd2757525dc5') + _lp('nil') + _lp('v0.1.000') + _lp('com.cctv.yangshipin.app.iphone') + _lp(str(_CK_PLATFORM)) + _lp('ex_json_bus') + _lp('ex_json_vs') + _lp(guard)
    pkt = bytearray(struct.pack('>H', len(body)) + body)
    pkt[18:22] = struct.pack('>I', _cksum(bytes(pkt)))
    pkt = bytes(pkt)
    enc = _tea_pkt(pkt, _CK_TEA) + struct.pack('>I', _cksum(pkt))
    enc = bytes((a ^ _CK_XOR[i & 15] for i, a in enumerate(enc)))
    b64 = base64.b64encode(enc).decode().replace('+', '_').replace('/', '-').rstrip('=')
    return {'cKey': '--01' + b64, 'guid': guid, 'ts': ts, 'flowId': '%s_%d' % (uuid.uuid4().hex.upper(), _CK_PLATFORM)}

_BK_H264 = base64.b64encode(b'H(30:1080,60:1080|30:1080,60:1080)').decode()

def bk_playurls(channel_id, live_pid, defn='fhd'):
    t = _ckey(channel_id)
    q = urllib.parse.urlencode({'atime': '120', 'livepid': live_pid, 'cnlid': channel_id, 'appVer': _CK_APPVER, 'app_version': '300090', 'caplv': '1', 'cmd': '2', 'defn': defn, 'device': 'iPhone', 'encryptVer': '4.2', 'getpreviewinfo': '0', 'hevclv': '0', 'lang': 'zh-Hans_CN', 'livequeue': '0', 'logintype': '1', 'nettype': '1', 'newnettype': '1', 'newplatform': str(_CK_PLATFORM), 'platform': str(_CK_PLATFORM), 'sdtfrom': 'v3021', 'spacode': '23', 'spaudio': '1', 'spdemuxer': '6', 'spdrm': '2', 'spdynamicrange': '1', 'spflv': '1', 'spflvaudio': '1', 'sphdrfps': '60', 'sphttps': '1', 'spvcode': _BK_H264, 'spvideo': '4', 'stream': '1', 'system': '1', 'sysver': 'ios18.2.1', 'uhd_flag': '0', 'cKey': t['cKey'], 'guid': t['guid'], 'fntick': str(t['ts']), 'flowid': t['flowId'], 'playbacktime': '0'})
    req = urllib.request.Request('https://bkliveinfo.ysp.cctv.cn/?' + q, headers={'User-Agent': 'qqlive', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=8) as r:
        p = json.loads(r.read().decode())
    if int(p.get('iretcode', -1)) != 0:
        raise RuntimeError('iretcode=%s %s' % (p.get('iretcode'), p.get('errinfo', '')))
    urls = []
    if p.get('playurl'):
        urls.append(p['playurl'])
    bu = p.get('backurl_list') or p.get('backurlList') or p.get('backurl')
    if isinstance(bu, list):
        for it in bu:
            urls.append(it if isinstance(it, str) else it.get('url') or it.get('playurl') or '')
    elif isinstance(bu, str):
        urls += [x for x in re.split('[;,]', bu) if x.strip()]
    urls = [u.strip() for u in dict.fromkeys(urls) if isinstance(u, str) and u.strip().startswith(('http://', 'https://'))]
    if not urls:
        raise RuntimeError('no playurl')
    urls.sort(key=lambda u: (0 if 'bklive-' in u else (1 if '.cctv.' in u else 2), u))
    return urls

def fetch_abs_playlist(url, depth=0):
    req = urllib.request.Request(url, headers={'User-Agent': 'qqlive', 'Referer': 'https://live.cctv.cn/', 'Accept': 'application/vnd.apple.mpegurl,application/json,*/*'})
    with urllib.request.urlopen(req, timeout=6) as r:
        text = r.read().decode('utf-8', 'replace')
        final = r.geturl()
    if depth < 2:
        lines = text.splitlines()
        for i, ln in enumerate(lines):
            if ln.strip().startswith('#EXT-X-STREAM-INF'):
                for j in range(i + 1, len(lines)):
                    s = lines[j].strip()
                    if s and (not s.startswith('#')):
                        return fetch_abs_playlist(urllib.parse.urljoin(final, s), depth + 1)
                break
    out = []
    for ln in text.splitlines():
        s = ln.strip()
        if s and (not s.startswith('#')):
            out.append(urllib.parse.urljoin(final, s))
        else:
            if 'URI="' in ln:
                ln = re.sub('URI="([^"]+)"', lambda m: 'URI="%s"' % urllib.parse.urljoin(final, m.group(1)), ln)
            out.append(ln)
    return '\n'.join(out)

DEFAULT_CHANNELS = [('cctv1', 'CCTV-1 综合', '2024078201', '600001859', 'fhd'), ('cctv2', 'CCTV-2 财经', '2024075401', '600001800', 'fhd'), ('cctv3', 'CCTV-3 综艺', '2024068501', '600001801', 'fhd'), ('cctv4', 'CCTV-4 中文国际', '2029797101', '600001814', 'fhd'), ('cctv5', 'CCTV-5 体育', '2024078401', '600001818', 'fhd'), ('cctv5p', 'CCTV-5+ 体育赛事', '2024078001', '600001817', 'fhd'), ('cctv6', 'CCTV-6 电影', '2013693901', '600108442', 'fhd'), ('cctv7', 'CCTV-7 国防军事', '2024072001', '600004092', 'fhd'), ('cctv8', 'CCTV-8 电视剧', '2029793001', '600001803', 'fhd'), ('cctv9', 'CCTV-9 纪录', '2024078601', '600004078', 'fhd'), ('cctv10', 'CCTV-10 科教', '2024078701', '600001805', 'fhd'), ('cctv11', 'CCTV-11 戏曲', '2027248701', '600001806', 'fhd'), ('cctv12', 'CCTV-12 社会与法', '2027248801', '600001807', 'fhd'), ('cctv13', 'CCTV-13 新闻', '2029797201', '600001811', 'fhd'), ('cctv14', 'CCTV-14 少儿', '2027248901', '600001809', 'fhd'), ('cctv15', 'CCTV-15 音乐', '2027249001', '600001815', 'fhd'), ('cctv16', 'CCTV-16 奥林匹克', '2027249101', '600098637', 'fhd'), ('cctv164k', 'CCTV-16 4K', '2027249301', '600099502', 'fhd'), ('cctv17', 'CCTV-17 农业农村', '2027249401', '600001810', 'fhd'), ('cctv4k', 'CCTV-4K 超高清', '2029810301', '600002264', 'fhd'), ('cctv8k', 'CCTV-8K 超高清', '2026774101', '600156816', 'fhd'), ('cgtn', 'CGTN', '2024181701', '600014550', 'fhd'), ('cgtnfr', 'CGTN 法语', '2024181801', '600084704', 'fhd'), ('cgtnru', 'CGTN 俄语', '2024181901', '600084758', 'fhd'), ('cgtnar', 'CGTN 阿拉伯语', '2024182001', '600084782', 'fhd'), ('cgtnes', 'CGTN 西班牙语', '2024182101', '600084744', 'fhd'), ('cgtndoc', 'CGTN 纪录', '2024182301', '600084781', 'fhd'), ('cctvfyjc', 'CCTV 风云剧场', '2025637102', '600099658', 'shd'), ('cctvdyjc', 'CCTV 第一剧场', '2026874202', '600099655', 'shd'), ('cctvhjjc', 'CCTV 怀旧剧场', '2026874302', '600099620', 'shd'), ('bjws', '北京卫视', '2024052703', '600002309', 'fhd'), ('jsws', '江苏卫视', '2024171103', '600002521', 'fhd'), ('dfws', '东方卫视', '2024054503', '600002483', 'fhd'), ('zjws', '浙江卫视', '2024054703', '600002520', 'fhd'), ('hnws', '湖南卫视', '2024054803', '600002475', 'fhd'), ('hbws', '湖北卫视', '2024171203', '600002508', 'fhd'), ('gdws', '广东卫视', '2024060903', '600002485', 'fhd'), ('gxws', '广西卫视', '2024060703', '600002509', 'fhd'), ('hljws', '黑龙江卫视', '2029797003', '600002498', 'fhd'), ('hainanws', '海南卫视', '2024055603', '600002506', 'fhd'), ('cqws', '重庆卫视', '2024061103', '600002531', 'fhd'), ('szws', '深圳卫视', '2024061303', '600002481', 'fhd'), ('scws', '四川卫视', '2024061403', '600002516', 'fhd'), ('henanws', '河南卫视', '2029797303', '600002525', 'fhd'), ('dnws', '东南卫视', '2024061503', '600002484', 'fhd'), ('gzws', '贵州卫视', '2024061603', '600002490', 'fhd'), ('jxws', '江西卫视', '2024061703', '600002503', 'fhd'), ('lnws', '辽宁卫视', '2024171303', '600002505', 'fhd'), ('ahws', '安徽卫视', '2024171403', '600002532', 'fhd'), ('hebws', '河北卫视', '2024171503', '600002493', 'fhd'), ('sdws', '山东卫视', '2029787903', '600002513', 'fhd'), ('tjws', '天津卫视', '2019927003', '600152137', 'fhd'), ('jlws', '吉林卫视', '2025561503', '600190405', 'fhd'), ('saxws', '陕西卫视', '2029795103', '600190400', 'fhd'), ('nxws', '宁夏卫视', '2025608503', '600190737', 'fhd'), ('nmgws', '内蒙古卫视', '2025561203', '600190401', 'fhd'), ('ynws', '云南卫视', '2025561303', '600190402', 'fhd'), ('shanxiws', '山西卫视', '2025560803', '600190407', 'fhd'), ('gsws', '甘肃卫视', '2025561703', '600190408', 'fhd'), ('qhws', '青海卫视', '2025559103', '600190406', 'fhd'), ('xizangws', '西藏卫视', '2025558003', '600190403', 'fhd'), ('xjws', '新疆卫视', '2019927403', '600152138', 'fhd'), ('cetv1', 'CETV-1', '2022823801', '600171827', 'fhd'), ('guoxue', '国学频道', '2029360403', '600213139', 'fhd')]

DEFAULT_CHANNELS = [c for c in DEFAULT_CHANNELS if c[0] not in EXCLUDE_CHANNELS]

ALIAS_MAP = {'anhuiws': 'ahws', 'beijingws': 'bjws', 'cctv16hd': 'cctv16', 'cctv5plus': 'cctv5p', 'cctvdiyijuchang': 'cctvdyjc', 'cctvfengyunjuchang': 'cctvfyjc', 'cctvhuaijiujuchang': 'cctvhjjc', 'cgtnalaboyu': 'cgtnar', 'cgtneyu': 'cgtnru', 'cgtnfayu': 'cgtnfr', 'cgtnwaiyujilu': 'cgtndoc', 'cgtnxibanyayu': 'cgtnes', 'chongqingws': 'cqws', 'dongfangws': 'dfws', 'fujiandongnanws': 'dnws', 'guangdongws': 'gdws', 'guangxiws': 'gxws', 'guizhouws': 'gzws', 'hebeiws': 'hebws', 'heilongjiangws': 'hljws', 'hubeiws': 'hbws', 'hunanws': 'hnws', 'jiangsuws': 'jsws', 'jiangxiws': 'jxws', 'jilinws': 'jlws', 'liaoningws': 'lnws', 'neimengguws': 'nmgws', 'ningxiaws': 'nxws', 'qinghaiws': 'qhws', 'shandongws': 'sdws', 'shannxiws': 'saxws', 'shenzhenws': 'szws', 'sichuanws': 'scws', 'tianjinws': 'tjws', 'xinjiangws': 'xjws', 'yunnanws': 'ynws', 'zhejiangws': 'zjws'}

TVG_IDS = {'cctv1': 'CCTV1', 'cctv2': 'CCTV2', 'cctv3': 'CCTV3', 'cctv4': 'CCTV4', 'cctv5': 'CCTV5', 'cctv5p': 'CCTV5+', 'cctv6': 'CCTV6', 'cctv7': 'CCTV7', 'cctv8': 'CCTV8', 'cctv9': 'CCTV9', 'cctv10': 'CCTV10', 'cctv11': 'CCTV11', 'cctv12': 'CCTV12', 'cctv13': 'CCTV13', 'cctv14': 'CCTV14', 'cctv15': 'CCTV15', 'cctv16': 'CCTV16', 'cctv164k': 'CCTV16', 'cctv17': 'CCTV17', 'cctv4k': 'CCTV4K', 'cctv8k': 'CCTV-8K', 'cgtn': 'CGTN英语', 'cgtnfr': 'CGTN法语', 'cgtnru': 'CGTN俄语', 'cgtnar': 'CGTN阿语', 'cgtnes': 'CGTN西语', 'cgtndoc': 'CGTN纪录', 'cctvdyjc': 'CCTV第一剧场', 'cctvfyjc': 'CCTV风云剧场', 'cctvhjjc': 'CCTV怀旧剧场', 'cetv1': 'CETV1', 'bjws': '北京卫视', 'jsws': '江苏卫视', 'dfws': '东方卫视', 'zjws': '浙江卫视', 'hnws': '湖南卫视', 'hbws': '湖北卫视', 'gdws': '广东卫视', 'gxws': '广西卫视', 'hljws': '黑龙江卫视', 'hainanws': '海南卫视', 'cqws': '重庆卫视', 'szws': '深圳卫视', 'scws': '四川卫视', 'henanws': '河南卫视', 'dnws': '东南卫视', 'gzws': '贵州卫视', 'jxws': '江西卫视', 'lnws': '辽宁卫视', 'ahws': '安徽卫视', 'hebws': '河北卫视', 'sdws': '山东卫视', 'tjws': '天津卫视', 'jlws': '吉林卫视', 'saxws': '陕西卫视', 'nxws': '宁夏卫视', 'nmgws': '内蒙古卫视', 'ynws': '云南卫视', 'shanxiws': '山西卫视', 'qhws': '青海卫视', 'xizangws': '西藏卫视', 'xjws': '新疆卫视', 'gsws': '甘肃卫视', 'guoxue': '国学'}

LOGO_BASE = 'https://garysclub.sharewithyou.dpdns.org/logos/ysp-live-logos'

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

REFRESH_INTERVAL = 6.0

BK_REFRESH_INTERVAL = 3.5

LOW_STREAM_IDLE_TIMEOUT = 30.0

LOW_PLAYLIST_MAX_AGE = 30.0

WINDOW = 300

MAX_SEGS = 120

BK_URL_TTL = 70

BK_PREFETCH_AGE = 45

TIMESHIFT_SUPPORTED = {'cctv1', 'cctv2', 'cctv3', 'cctv4', 'cctv5', 'cctv5p', 'cctv6', 'cctv7', 'cctv8', 'cctv9', 'cctv10', 'cctv13', 'cctv8k', 'cgtn', 'cgtnfr', 'cgtnru', 'cgtnar', 'cgtnes', 'cgtndoc', 'cetv1', 'guoxue', 'bjws', 'jsws', 'dfws', 'zjws', 'hnws', 'hbws', 'gdws', 'gxws', 'hljws', 'hainanws', 'cqws', 'szws', 'scws', 'henanws', 'dnws', 'gzws', 'jxws', 'lnws', 'ahws', 'hebws', 'sdws', 'tjws', 'jlws', 'saxws', 'nxws', 'nmgws', 'ynws', 'shanxiws', 'qhws', 'xizangws', 'xjws', 'gsws'}

def get_channel_group(slug: str) -> str:
    s = ALIAS_MAP.get(slug.lower(), slug.lower())
    if s.startswith('cctv') or s.startswith('cgtn'):
        return '央视'
    return '卫视'

def parse_catchup_time_val(val_str: str | None) -> int | None:
    if not val_str:
        return None
    val = val_str.strip()
    if not val:
        return None
    cst = datetime.timezone(datetime.timedelta(hours=8))
    if 'T' in val or ('-' in val and ':' in val):
        try:
            iso_val = val[:-1] + '+00:00' if val.upper().endswith('Z') else val
            dt = datetime.datetime.fromisoformat(iso_val)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=cst)
            return int(dt.timestamp())
        except Exception:
            pass
    is_utc = val.upper().endswith('Z')
    clean_val = re.sub('\\.\\d+', '', val)
    digits = ''.join((c for c in clean_val if c.isdigit()))
    if not digits:
        return None
    if len(digits) == 10:
        return int(digits)
    if len(digits) == 13:
        return int(int(digits) / 1000)
    tz = datetime.timezone.utc if is_utc else cst
    if len(digits) >= 14:
        try:
            dt = datetime.datetime.strptime(digits[:14], '%Y%m%d%H%M%S').replace(tzinfo=tz)
            return int(dt.timestamp())
        except Exception:
            pass
    if len(digits) == 12:
        try:
            dt = datetime.datetime.strptime(digits, '%Y%m%d%H%M').replace(tzinfo=tz)
            return int(dt.timestamp())
        except Exception:
            pass
    return None

def parse_catchup_query(query_str: str) -> tuple[int, int] | None:
    if not query_str:
        return None
    qs = urllib.parse.parse_qs(query_str)
    now = int(time.time())
    start_ts = None
    end_ts = None
    if 'playseek' in qs:
        ps = qs['playseek'][0]
        if '-' in ps:
            parts = ps.split('-', 1)
            start_ts = parse_catchup_time_val(parts[0])
            end_ts = parse_catchup_time_val(parts[1])
        else:
            start_ts = parse_catchup_time_val(ps)
    if not start_ts and 'start' in qs:
        start_ts = parse_catchup_time_val(qs['start'][0])
    if not end_ts and 'end' in qs:
        end_ts = parse_catchup_time_val(qs['end'][0])
    if not start_ts and 'utc' in qs:
        start_ts = parse_catchup_time_val(qs['utc'][0])
    if not end_ts and 'lutc' in qs:
        end_ts = parse_catchup_time_val(qs['lutc'][0])
    if not start_ts and 'starttime' in qs:
        start_ts = parse_catchup_time_val(qs['starttime'][0])
    if not end_ts and 'endtime' in qs:
        end_ts = parse_catchup_time_val(qs['endtime'][0])
    if start_ts is not None:
        if end_ts is None or end_ts <= start_ts:
            end_ts = max(start_ts + 60, min(start_ts + 7200, now))
        return (start_ts, end_ts)
    return None

_inflight_refresh: dict[str, threading.Event] = {}

_inflight_lock = threading.Lock()

def coalesce_refresh(slug: str, refresh_fn, timeout=None):
    with _inflight_lock:
        if slug in _inflight_refresh:
            ev = _inflight_refresh[slug]
            wait = True
        else:
            ev = threading.Event()
            _inflight_refresh[slug] = ev
            wait = False
    if wait:
        ev.wait(timeout=6.0 if timeout is None else timeout)
        return

    def _run():
        try:
            refresh_fn()
        finally:
            with _inflight_lock:
                _inflight_refresh.pop(slug, None)
            ev.set()
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    if timeout is not None:
        ev.wait(timeout=timeout)
    else:
        t.join()

class ApiFlowLimiter:

    def __init__(self, min_interval_ms: int=250, jitter_ms: int=100):
        self.min_interval = min_interval_ms / 1000.0
        self.jitter = jitter_ms / 1000.0
        self.lock = threading.Lock()
        self.last_call = 0.0

    def wait_slot(self):
        with self.lock:
            now = time.time()
            target_delay = self.min_interval + random.uniform(0.0, self.jitter)
            diff = now - self.last_call
            if diff < target_delay:
                time.sleep(target_delay - diff)
            self.last_call = time.time()

global_flow_limiter = ApiFlowLimiter()

class TsSegmentCache:

    def __init__(self, max_mb: int=100, max_age_sec: int=180):
        self.max_bytes = max_mb * 1024 * 1024
        self.max_age = max_age_sec
        self.lock = threading.Lock()
        self.cache: dict[str, tuple[bytes, dict, float]] = {}
        self.order = collections.deque()
        self.curr_bytes = 0
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> tuple[bytes, dict] | None:
        with self.lock:
            item = self.cache.get(key)
            if not item:
                self.misses += 1
                return None
            data, headers, expire_at = item
            if time.time() > expire_at:
                self.cache.pop(key, None)
                try:
                    self.order.remove(key)
                except ValueError:
                    pass
                self.curr_bytes -= len(data)
                self.misses += 1
                return None
            self.hits += 1
            return (data, headers)

    def set(self, key: str, data: bytes, headers: dict):
        with self.lock:
            if len(data) > self.max_bytes:
                return
            if key in self.cache:
                old = self.cache.pop(key)
                self.curr_bytes -= len(old[0])
                try:
                    self.order.remove(key)
                except ValueError:
                    pass
            now = time.time()
            while self.curr_bytes + len(data) > self.max_bytes and self.order:
                old_key = self.order.popleft()
                old_val = self.cache.pop(old_key, None)
                if old_val:
                    self.curr_bytes -= len(old_val[0])
            self.cache[key] = (data, headers, now + self.max_age)
            self.order.append(key)
            self.curr_bytes += len(data)

    def stats(self) -> dict:
        with self.lock:
            total = max(1, self.hits + self.misses)
            return {'count': len(self.cache), 'size_mb': round(self.curr_bytes / (1024 * 1024), 2), 'hits': self.hits, 'misses': self.misses, 'hit_rate': f'{round(self.hits / total * 100, 1)}%'}

global_ts_cache = TsSegmentCache(max_mb=CACHE_MB)

class ChannelDirectory:

    def __init__(self):
        self.lock = threading.Lock()
        self.channels_meta: dict[str, dict] = {}
        self.canonical_slugs: list[str] = []
        self.load_defaults()

    def load_defaults(self):
        self.canonical_slugs.clear()
        for slug, name, sid, pid, defn in DEFAULT_CHANNELS:
            grp = get_channel_group(slug)
            tid = TVG_IDS.get(slug, slug.upper())
            logo = f'{LOGO_BASE}/{slug}.png'
            self.channels_meta[slug] = {'slug': slug, 'name': name, 'sid': sid, 'pid': pid, 'defn': defn, 'logo': logo, 'group': grp, 'tvg_id': tid}
            self.canonical_slugs.append(slug)

    def get_meta(self, slug: str) -> dict | None:
        slug = ALIAS_MAP.get(slug.lower(), slug.lower())
        with self.lock:
            return self.channels_meta.get(slug)

    def all_channels(self) -> list[dict]:
        return self.unique_channels()

    def unique_channels(self) -> list[dict]:
        with self.lock:
            return [self.channels_meta[s] for s in self.canonical_slugs if s in self.channels_meta]

global_channel_dir = ChannelDirectory()

class Channel:

    def __init__(self, slug, name, sid, pid, defn):
        self.slug, self.name, self.sid, self.pid, self.defn = (slug, name, sid, pid, defn)
        self.refresh_lock = threading.Lock()
        self.lock = threading.Lock()
        self.segments = {}
        self.order = deque()
        self.seen_keys = deque(maxlen=MAX_SEGS * 2)
        self.seq = 0
        self.last_access = 0.0
        self.thread = None
        self.last_error = ''
        self.last_ok = 0.0
        self.mode = PRIMARY_MODE
        self.last_pdt = ''
        self.bk_urls = []
        self.bk_urls_time = 0.0
        self.bk_last_host = ''
        self.bk_last_seq = -1
        self.bk_playlist = ''
        self.wake_event = threading.Event()
        self._starting = False
        self.last_built_playlist = ''
        self.last_built_time = 0.0

def seg_key(url, pdt):
    if pdt:
        return 'pdt:' + pdt
    p = urllib.parse.urlsplit(url)
    return p.scheme + '://' + p.netloc + p.path

def jce_note_access(ch, now):
    if now - ch.last_access >= LOW_STREAM_IDLE_TIMEOUT and ch.refresh_lock.acquire(blocking=False):
        try:
            with ch.lock:
                if now - ch.last_access >= LOW_STREAM_IDLE_TIMEOUT:
                    for key in ('jce_live_url', 'jce_live_expiry', 'jce_live_tail', 'jce_live_rows', 'jce_target', 'jce_accepted_generation', 'jce_sequence_offset', 'jce_live_playlist', 'jce_live_media_end', 'jce_suppress_pdt'):
                        if hasattr(ch, key):
                            delattr(ch, key)
                    ch.last_built_playlist = ''
                    ch.last_built_time = 0.0
                    ch.last_ok = 0.0
        finally:
            ch.refresh_lock.release()
    ch.last_access = now

def parse_jce_live_window(text, base_url, now, with_target=False):
    """Accept plain media HLS with monotonic PDT; preserve explicit wall-clock gaps."""
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    if not lines or lines[0] != '#EXTM3U':
        raise RuntimeError('JCE invalid media playlist')
    allowed = ('#EXTM3U', '#EXT-X-VERSION:', '#EXT-X-TARGETDURATION:', '#EXT-X-MEDIA-SEQUENCE:', '#EXT-X-PROGRAM-DATE-TIME:', '#EXTINF:', '#EXT-X-ENDLIST', '#EXT-X-PLAYLIST-TYPE:', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-DISCONTINUITY-SEQUENCE:', '#EXT-X-ALLOW-CACHE:', '#EXT-X-START:', '#EXT-X-DISCONTINUITY')
    seq, duration, stamp, rows = (0, None, None, [])
    target = None
    previous_end = None
    previous_start = None
    previous_duration = None
    for line in lines[1:]:
        if line.startswith('#EXT') and (not any((line == tag or line.startswith(tag) for tag in allowed))):
            raise RuntimeError('JCE unsupported HLS feature')
        if line.startswith('#EXT-X-TARGETDURATION:'):
            target = int(line.split(':', 1)[1])
            if not 0 < target <= 30:
                raise RuntimeError('JCE invalid target duration')
        elif line.startswith('#EXT-X-MEDIA-SEQUENCE:'):
            if rows:
                raise RuntimeError('JCE late media sequence')
            seq = int(line.split(':', 1)[1])
            if seq < 0:
                raise RuntimeError('JCE invalid media sequence')
        elif line.startswith('#EXT-X-PROGRAM-DATE-TIME:'):
            value = datetime.datetime.fromisoformat(line.split(':', 1)[1].replace('Z', '+00:00'))
            if value.tzinfo is None:
                raise RuntimeError('JCE PDT has no timezone')
            stamp = value.timestamp()
        elif line.startswith('#EXTINF:'):
            if duration is not None:
                raise RuntimeError('JCE missing segment URI')
            duration = float(line.split(':', 1)[1].split(',')[0])
            if not math.isfinite(duration) or not 0 < duration <= 30:
                raise RuntimeError('JCE invalid segment duration')
        elif not line.startswith('#'):
            if duration is None or stamp is None:
                raise RuntimeError('JCE missing duration or PDT')
            if previous_start is not None and stamp <= previous_start:
                raise RuntimeError('JCE non-increasing PDT')
            if previous_end is not None:
                if stamp + duration <= previous_end:
                    raise RuntimeError('JCE non-increasing segment end')
                gap = stamp - previous_end
                overlap_limit = min(0.15, 0.05 * min(previous_duration, duration))
                if gap < -overlap_limit - 1e-07:
                    raise RuntimeError('JCE overlapping PDT (%.3fs)' % -gap)
            previous_start = stamp
            previous_duration = duration
            url = urllib.parse.urljoin(base_url, line)
            if urllib.parse.urlsplit(url).scheme not in ('http', 'https'):
                raise RuntimeError('JCE invalid media URI')
            rows.append((seq + len(rows), stamp, duration, url))
            previous_end = stamp + duration
            stamp, duration = (previous_end, None)
    if target is None or any((math.floor(r[2] + 0.5) > target for r in rows)):
        raise RuntimeError('JCE missing/invalid target duration')
    if duration is not None or not rows:
        raise RuntimeError('JCE incomplete media playlist')
    completed = [r for r in rows if r[1] + r[2] <= now]
    cut = 0
    for i in range(1, len(completed)):
        if completed[i][1] - (completed[i - 1][1] + completed[i - 1][2]) > 30:
            cut = i
    completed = completed[cut:]
    if len(completed) < 4 or now - (completed[-1][1] + completed[-1][2]) > 30:
        raise RuntimeError('JCE no recent completed media')
    selected = completed[:-1][-6:]
    return (selected, target) if with_target else selected

def jce_fetch(ch):
    if time.time() < getattr(ch, 'jce_media_blocked_until', 0):
        raise JceRateLimited('JCE media cooldown')
    now = time.time()
    if not getattr(ch, 'jce_live_url', '') or now >= ch.jce_live_expiry:
        end = int(now) + 900
        url = jce_timeshift_url(ch.pid, ch.sid, int(now) - 120, end, ch.defn, active=lambda: time.time() - ch.last_access < LOW_STREAM_IDLE_TIMEOUT)
        ch.jce_live_url, ch.jce_live_expiry = (url, end - 60)
        ch.jce_anchor_generation = getattr(ch, 'jce_anchor_generation', 0) + 1
    req = urllib.request.Request(ch.jce_live_url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise RuntimeError('JCE playlist too large')
            text = raw.decode('utf-8', 'strict')
            media_base = response.geturl()
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            delay = 60.0
            header = exc.headers.get('Retry-After') if exc.headers else None
            if header:
                try:
                    delay = max(delay, float(header))
                except (ValueError, TypeError):
                    try:
                        from email.utils import parsedate_to_datetime
                        delay = max(delay, parsedate_to_datetime(header).timestamp() - time.time())
                    except (ValueError, TypeError, OverflowError):
                        pass
            if not math.isfinite(delay):
                delay = 60.0
            ch.jce_media_blocked_until = time.time() + delay
            raise JceRateLimited('JCE media cooldown') from exc
        ch.jce_live_url = ''
        ch.jce_live_expiry = 0
        raise
    except Exception:
        ch.jce_live_url = ''
        ch.jce_live_expiry = 0
        raise
    try:
        rows, target = parse_jce_live_window(text, media_base, time.time(), with_target=True)
        if getattr(ch, 'jce_target', target) != target:
            raise RuntimeError('JCE target duration changed; reopen required')
        ch.jce_pending_target = target
        offset = getattr(ch, 'jce_sequence_offset', 0)
        if getattr(ch, 'jce_accepted_generation', 0) != ch.jce_anchor_generation:
            old = getattr(ch, 'jce_live_rows', {})
            if old:
                offsets = {oldseq - seq for seq, stamp, duration, url in rows for oldseq, (oldstamp, oldduration) in old.items() if abs(stamp - oldstamp) < 0.05 and abs(duration - oldduration) < 0.05}
                if len(offsets) != 1:
                    raise RuntimeError('JCE new window lacks unambiguous PDT overlap; reopen required')
                offset = offsets.pop()
            else:
                offset = 0
    except Exception:
        ch.jce_live_url = ''
        ch.jce_live_expiry = 0
        raise
    rows = [(seq + offset, stamp, duration, url) for seq, stamp, duration, url in rows]
    previous = getattr(ch, 'jce_live_tail', None)
    tail = rows[-1]
    if previous is not None:
        if tail[0] < previous[0] or tail[1] < previous[1]:
            raise RuntimeError('JCE live window regressed')
        if (tail[0] == previous[0]) != (abs(tail[1] - previous[1]) < 0.05):
            raise RuntimeError('JCE media sequence/PDT mismatch')
        old = getattr(ch, 'jce_live_rows', {})
        for seq, stamp, duration, url in rows:
            if seq in old and (abs(stamp - old[seq][0]) > 0.05 or abs(duration - old[seq][1]) > 0.05):
                raise RuntimeError('JCE overlapping media changed')
    ch.jce_pending_offset = offset
    return rows

def defn_label(defn):
    d = (defn or '').strip().lower()
    if d == 'fhd':
        return '1080p'
    if d == 'shd':
        return '720p'
    return defn or '1080p'

def jce_refresh(ch):
    rows = jce_fetch(ch)
    target = ch.jce_pending_target
    suppress_pdt = getattr(ch, 'jce_suppress_pdt', False) or any((rows[i][1] < rows[i - 1][1] + rows[i - 1][2] - 1e-06 for i in range(1, len(rows))))
    out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:%d' % target, '#EXT-X-MEDIA-SEQUENCE:%d' % rows[0][0]]
    for seq, stamp, duration, url in rows:
        pdt = datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).isoformat()
        if not suppress_pdt:
            out.append('#EXT-X-PROGRAM-DATE-TIME:' + pdt)
        out += ['#EXTINF:%.6f,' % duration, url]
    with ch.lock:
        ch.jce_suppress_pdt = suppress_pdt
        ch.jce_live_playlist = '\n'.join(out) + '\n'
        ch.jce_target = target
        ch.jce_sequence_offset = ch.jce_pending_offset
        ch.jce_accepted_generation = ch.jce_anchor_generation
        ch.jce_live_tail = rows[-1][:2]
        ch.jce_live_rows = {r[0]: (r[1], r[2]) for r in rows}
        ch.jce_live_media_end = rows[-1][1] + rows[-1][2]
        ch.last_error = ''
    return True

_MEDIA_SEQ_RE = re.compile(r'^#EXT-X-MEDIA-SEQUENCE:(\d+)', re.M)

def _extract_media_seq(pl: str) -> int:
    m = _MEDIA_SEQ_RE.search(pl)
    return int(m.group(1)) if m else -1

def bk_refresh(ch):
    now = time.time()
    url_age = now - ch.bk_urls_time
    if not ch.bk_urls or url_age > BK_URL_TTL:
        global_flow_limiter.wait_slot()
        ch.bk_urls = bk_playurls(ch.sid, ch.pid, ch.defn)
        ch.bk_urls_time = time.time()
        log(f'[{ch.slug}] bkliveinfo 通道就绪 ({len(ch.bk_urls)} 地址)', min_interval=60.0)
    elif url_age > BK_PREFETCH_AGE:
        # 令牌接近过期前静默续期，失败则继续沿用当前有效地址
        try:
            global_flow_limiter.wait_slot()
            fresh_urls = bk_playurls(ch.sid, ch.pid, ch.defn)
            if fresh_urls:
                ch.bk_urls = fresh_urls
                ch.bk_urls_time = time.time()
        except Exception:
            pass
    last_err = ''
    for attempt in range(2):
        candidates = list(ch.bk_urls)
        if ch.bk_last_host:
            candidates.sort(key=lambda u: 0 if urllib.parse.urlsplit(u).hostname == ch.bk_last_host else 1)
        for u in candidates:
            try:
                pl = fetch_abs_playlist(u)
                if '#EXTM3U' not in pl:
                    continue
                host = urllib.parse.urlsplit(u).hostname or ''
                seq = _extract_media_seq(pl)
                with ch.lock:
                    same_host = (not ch.bk_last_host) or (host == ch.bk_last_host)
                    # 防止同节点边缘缓存短暂回退 MEDIA-SEQUENCE 导致播放器断流黑屏
                    if (same_host and seq >= 0 and ch.bk_last_seq >= 0
                            and seq < ch.bk_last_seq and ch.bk_playlist
                            and (time.time() - ch.last_ok) < 12.0):
                        ch.last_error = ''
                        return True
                    ch.bk_last_host = host
                    if seq >= 0:
                        ch.bk_last_seq = seq
                    ch.bk_playlist = pl
                    ch.last_error = ''
                return True
            except urllib.error.HTTPError as e:
                last_err = 'HTTPError: HTTP %s' % e.code
                if e.code in (401, 403, 410) and attempt == 0:
                    break
                continue
            except Exception as e:
                last_err = '%s: %s' % (type(e).__name__, e)
        if attempt == 0:
            try:
                global_flow_limiter.wait_slot()
                ch.bk_urls = bk_playurls(ch.sid, ch.pid, ch.defn)
                ch.bk_urls_time = time.time()
                log(f'[{ch.slug}] {defn_label(ch.defn)} 地址已过期，已重新拉取', min_interval=10.0)
            except Exception as e:
                last_err = '%s: %s' % (type(e).__name__, e)
    ch.bk_urls = []
    ch.bk_urls_time = 0
    raise RuntimeError(last_err[:120] or 'bk playlist failed')

def refresh_once(ch):
    if not ch.refresh_lock.acquire(blocking=False):
        return False
    try:
        return _refresh_once(ch)
    finally:
        ch.refresh_lock.release()

def _refresh_once(ch):
    try:
        if ch.mode == 'bk':
            try:
                ok = bk_refresh(ch)
            except Exception as bk_err:
                if ch.slug not in FORCE_BK and jce_request_gate.remaining() <= 0:
                    log(f'[{ch.slug}] bkliveinfo 失败 ({type(bk_err).__name__}: {bk_err})，尝试切换 JCE 备用通道', min_interval=15.0)
                    try:
                        ok = jce_refresh(ch)
                        if ok:
                            ch.mode = 'jce'
                    except Exception as jce_err:
                        raise RuntimeError('bk: %s; jce: %s' % (bk_err, jce_err)) from jce_err
                else:
                    raise
        else:
            try:
                ok = jce_refresh(ch)
            except Exception as jce_err:
                reason = '域名受限' if isinstance(jce_err, DeadHostError) else ('%s: %s' % (type(jce_err).__name__, jce_err))
                log(f'[{ch.slug}] JCE 失败 ({reason})，自动切换 bkliveinfo 备用通道', min_interval=10.0)
                try:
                    ok = bk_refresh(ch)
                    if ok:
                        ch.mode = 'bk'
                except Exception as bk_err:
                    raise RuntimeError('jce: %s; bk: %s' % (jce_err, bk_err)) from bk_err
        if ok:
            ch.last_ok = time.time()
        return ok
    except Exception as e:
        ch.last_error = ('%s: %s' % (type(e).__name__, e))[:180]
        log(f'[{ch.slug}] {defn_label(ch.defn)} 刷新异常: {ch.last_error}', min_interval=15.0)
        return False

def _channel_refresh_interval(ch) -> float:
    return BK_REFRESH_INTERVAL if ch.mode == 'bk' else REFRESH_INTERVAL

def refresh_loop(ch):
    log(f'[{ch.slug}] {defn_label(ch.defn)} 后台拉取启动 [{ch.mode}]', min_interval=10.0)
    fails = 0
    interval = _channel_refresh_interval(ch)
    if time.time() - ch.last_ok < interval:
        build_playlist(ch, holdback=True)
        ch.wake_event.wait(timeout=interval)
        ch.wake_event.clear()
    while time.time() - ch.last_access < LOW_STREAM_IDLE_TIMEOUT:
        ok = refresh_once(ch)
        if ok:
            build_playlist(ch, holdback=True)
        fails = 0 if ok else fails + 1
        interval = _channel_refresh_interval(ch)
        wait_sec = interval if fails < 3 else min(15.0, interval * 3.0)
        ch.wake_event.wait(timeout=wait_sec)
        ch.wake_event.clear()
    log(f'[{ch.slug}] 空闲超时，已停止后台拉取', min_interval=10.0)

def ensure_channel(ch):
    now = time.time()
    ch.last_access = now
    wait_only = False
    with ch.lock:
        if ch._starting:
            wait_only = True
        else:
            thread_dead = ch.thread is None or not ch.thread.is_alive()
            has_pl = bool(ch.bk_playlist) if ch.mode == 'bk' else bool(getattr(ch, 'jce_live_playlist', '') or ch.segments)
            cache_stale = now - ch.last_ok > LOW_PLAYLIST_MAX_AGE or not has_pl
            if cache_stale:
                if thread_dead:
                    ch.segments.clear()
                    ch.order.clear()
                    ch.seen_keys.clear()
                    ch.last_pdt = ''
                    ch.bk_playlist = ''
                    ch.bk_last_seq = -1
                need_fetch = True
            else:
                need_fetch = False
            if need_fetch or thread_dead:
                ch._starting = True
            else:
                return
    if wait_only:
        coalesce_refresh(ch.slug, lambda: refresh_once(ch), timeout=15.0)
        return
    try:
        if need_fetch:
            coalesce_refresh(ch.slug, lambda: refresh_once(ch), timeout=15.0)
        if thread_dead:
            ch.thread = threading.Thread(target=refresh_loop, args=(ch,), daemon=True)
            ch.thread.start()
    finally:
        with ch.lock:
            ch._starting = False

def build_playlist(ch, holdback: bool=True):
    with ch.lock:
        if time.time() - ch.last_ok > LOW_PLAYLIST_MAX_AGE:
            return None
        if ch.mode == 'jce' and getattr(ch, 'jce_live_playlist', ''):
            if time.time() - ch.jce_live_media_end > 30:
                return None
            ch.last_built_playlist = ch.jce_live_playlist
            ch.last_built_time = time.time()
            return ch.jce_live_playlist
        if ch.mode == 'bk':
            res = ch.bk_playlist or None
            if res:
                ch.last_built_playlist = res
                ch.last_built_time = time.time()
            return res
        keys = list(ch.order)[-15:]
        segs = [ch.segments[k] for k in keys if k in ch.segments]
    if not segs:
        return None
    if holdback and len(segs) >= 4:
        display_segs = segs[:-1]
    else:
        display_segs = segs
    target = max(6, max((int(s[1] + 0.5) for s in display_segs)))
    out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:%d' % target, '#EXT-X-MEDIA-SEQUENCE:%d' % display_segs[0][0]]
    for _, dur, pdt, url in display_segs:
        if pdt:
            out.append('#EXT-X-PROGRAM-DATE-TIME:' + pdt)
        out.append('#EXTINF:%.3f,' % dur)
        out.append(url)
    res = '\n'.join(out) + '\n'
    with ch.lock:
        ch.last_built_playlist = res
        ch.last_built_time = time.time()
    return res

def trigger_background_refresh(ch):
    with ch.lock:
        if ch._starting:
            return
        if ch.thread is not None and ch.thread.is_alive():
            ch.wake_event.set()
            return
    with _inflight_lock:
        if ch.slug in _inflight_refresh:
            return

    def _do():
        if refresh_once(ch):
            build_playlist(ch, holdback=True)
    threading.Thread(target=coalesce_refresh, args=(ch.slug, _do), daemon=True).start()

CHANNEL_MAP: dict[str, Channel] = {c[0]: Channel(*c) for c in DEFAULT_CHANNELS}

FORCE_BK = {'cctv11', 'cctv12', 'cctv14', 'cctv15', 'cctv16', 'cctv17', 'cctvfyjc', 'cctvdyjc', 'cctvhjjc'}

for _s in FORCE_BK:
    if _s in CHANNEL_MAP:
        CHANNEL_MAP[_s].mode = 'bk'

def get_channel_instance(slug: str) -> Channel | None:
    slug = normalize_channel(slug)
    canonical = ALIAS_MAP.get(slug, slug)
    if canonical in CHANNEL_MAP:
        return CHANNEL_MAP[canonical]
    meta = global_channel_dir.get_meta(canonical)
    if meta:
        ch = Channel(meta['slug'], meta['name'], meta['sid'], meta['pid'], meta['defn'])
        if canonical in FORCE_BK:
            ch.mode = 'bk'
        CHANNEL_MAP[canonical] = ch
        return ch
    return None


# ======================================================================
#  以下为 VPS / Docker 版新增部分：访问口令 · 对外地址 · 分片中转 · HTTP 服务
# ======================================================================

# ===================== 访问口令 / 对外地址 =====================
TOKEN_RE = re.compile(r'^[A-Za-z0-9_-]{8,64}$')
_HOST_RE = re.compile(r'^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$')


def strip_token(path: str):
    """设置了 YSP_TOKEN 时，路径必须形如 /<TOKEN>/xxx。返回去掉口令后的路径；口令不对返回 None。"""
    if not TOKEN:
        return path
    if not path.startswith('/'):
        return None
    seg, _, rest = path[1:].partition('/')
    if not hmac.compare_digest(seg.encode('utf-8'), TOKEN.encode('utf-8')):
        return None
    return '/' + rest


def public_root(headers) -> str:
    """生成写进 m3u / m3u8 的基础地址（含口令前缀）。优先 YSP_PUBLIC_URL，其次反代头，最后 Host。"""
    if PUBLIC_URL:
        root = PUBLIC_URL
    else:
        proto = (headers.get('X-Forwarded-Proto') or 'http').split(',')[0].strip().lower()
        if proto not in ('http', 'https'):
            proto = 'http'
        host = (headers.get('X-Forwarded-Host') or headers.get('Host') or '').split(',')[0].strip()
        if not host or not _HOST_RE.match(host):
            host = 'localhost:%d' % server_port
        root = '%s://%s' % (proto, host)
    return root + ('/' + TOKEN if TOKEN else '')


# ===================== 分片中转（可选，YSP_PROXY_SEGMENTS=1） =====================
SEG_ALLOWED_SUFFIXES = (
    '.cctv.cn', '.cctv.com', '.cctvpic.com', '.citvc.com', '.yangshipin.cn', '.cntv.cn', '.cntv.com',
    '.myqcloud.com', '.qqlive.com', '.gtimg.cn', '.smtcdns.net', '.smtcdns.com', '.tcdnlive.com',
    '.alicdn.com', '.alikunlun.com', '.wscdns.com', '.chinanetcenter.com', '.bdydns.com',
    '.ksyungslb.com', '.ks-cdn.com',
) + SEG_ALLOW_EXTRA
MAX_SEG_BYTES = 12 * 1024 * 1024
_SEG_RE = re.compile(r'^/seg/([A-Za-z0-9_-]{8,6000})(?:\.\w{1,5})?$')
_RANGE_RE = re.compile(r'^bytes=\d*-\d*$')
_PASS_HEADERS = ('content-type', 'content-range', 'accept-ranges', 'content-length')
_URI_ATTR = re.compile(r'URI="([^"]+)"')
_SSL_CTX = ssl.create_default_context()


def _b64e(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode('utf-8')).decode('ascii').rstrip('=')


def _b64d(t: str) -> str:
    return base64.urlsafe_b64decode((t + '=' * (-len(t) % 4)).encode('ascii')).decode('utf-8')


def seg_host_allowed(url: str) -> bool:
    try:
        p = urllib.parse.urlsplit(url)
        host = (p.hostname or '').lower().rstrip('.')
    except ValueError:
        return False
    if p.scheme not in ('http', 'https') or not host:
        return False
    return any(host == s[1:] or host.endswith(s) for s in SEG_ALLOWED_SUFFIXES)


def proxify_playlist(text: str, prefix: str) -> str:
    """把播放列表里的绝对分片地址改写为经本服务中转：<prefix><base64url>.ts"""

    def enc(u: str, suffix: str = '') -> str:
        return prefix + _b64e(u) + suffix if u.startswith(('http://', 'https://')) else u

    out = []
    for ln in text.splitlines():
        s = ln.strip()
        if not s:
            continue
        if s.startswith('#'):
            if 'URI="' in s:
                s = _URI_ATTR.sub(lambda m: 'URI="%s"' % enc(m.group(1)), s)
            out.append(s)
        else:
            out.append(enc(s, '.ts'))
    return '\n'.join(out) + '\n'


def open_upstream(url: str, range_header: str, head_only: bool):
    """连接上游并返回 (conn, resp)。服务端跟随最多 3 次重定向，每一跳都重新校验域名白名单。"""
    for _hop in range(4):
        p = urllib.parse.urlsplit(url)
        https = p.scheme == 'https'
        port = p.port or (443 if https else 80)
        if https:
            conn = http.client.HTTPSConnection(p.hostname, port, timeout=15, context=_SSL_CTX)
        else:
            conn = http.client.HTTPConnection(p.hostname, port, timeout=15)
        try:
            target = (p.path or '/') + ('?' + p.query if p.query else '')
            headers = {'User-Agent': UA, 'Referer': 'https://live.cctv.cn/', 'Accept': '*/*', 'Accept-Encoding': 'identity', 'Connection': 'close'}
            if range_header:
                headers['Range'] = range_header
            conn.request('HEAD' if head_only else 'GET', target, headers=headers)
            resp = conn.getresponse()
        except Exception:
            conn.close()
            raise
        if resp.status in (301, 302, 303, 307, 308):
            loc = resp.getheader('Location')
            conn.close()
            if not loc:
                raise RuntimeError('上游重定向缺少 Location')
            url = urllib.parse.urljoin(url, loc)
            if not seg_host_allowed(url):
                raise PermissionError(urllib.parse.urlsplit(url).hostname or '?')
            continue
        return conn, resp
    raise RuntimeError('上游重定向次数过多')


# ===================== HTTP 服务 =====================
class Handler(BaseHTTPRequestHandler):
    server_version = 'ysp-live-lite'
    protocol_version = 'HTTP/1.1'
    timeout = 60  # 客户端空闲 / 写入卡住 60 秒后释放线程

    def version_string(self):
        return self.server_version

    def log_message(self, fmt, *args):
        pass

    # ---- 基础发送 ----
    def _send(self, code, body, ctype='text/plain; charset=utf-8', head_only=False, extra_headers=None):
        data = body.encode('utf-8') if isinstance(body, str) else body
        try:
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-cache, no-store, max-age=0')
            if extra_headers:
                for k, v in extra_headers.items():
                    self.send_header(k, v)
            self.end_headers()
            self._started = True
            if not head_only:
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True

    def _send_playlist(self, text, head_only, extra=None):
        if PROXY_SEGMENTS:
            text = proxify_playlist(text, public_root(self.headers) + '/seg/')
        self._send(200, text, 'application/vnd.apple.mpegurl', head_only=head_only, extra_headers=extra)

    # ---- 入口 ----
    def do_HEAD(self):
        self.do_GET(head_only=True)

    def do_GET(self, head_only=False):
        self._started = False
        try:
            self._route(head_only)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True
        except Exception as e:  # 单个请求出错不应影响服务
            log('[系统] 请求处理异常 %s: %s' % (type(e).__name__, e), min_interval=10.0)
            self.close_connection = True
            if not self._started:
                try:
                    self._send(500, 'internal error\n', head_only=head_only)
                except Exception:
                    pass

    def _route(self, head_only):
        parts = urllib.parse.urlsplit(self.path)
        if parts.path == '/healthz':  # 容器健康检查：不需要口令，不泄露任何信息
            return self._send(200, 'ok\n', head_only=head_only)
        path = strip_token(parts.path)
        if path is None:
            return self._send(404, 'not found\n', head_only=head_only)

        if path in ('/', '/index.html'):
            return self._index(head_only)
        if path == '/favicon.ico':
            fav = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📺</text></svg>'
            return self._send(200, fav, 'image/svg+xml', head_only=head_only)
        if path == '/all.m3u':
            return self._all_m3u(parts.query, head_only)
        if path == '/health':
            return self._health(head_only)
        if path == '/diag':
            return self._diag(head_only)
        m = _SEG_RE.match(path)
        if m:
            if not PROXY_SEGMENTS:
                return self._send(404, 'not found\n', head_only=head_only)
            return self._serve_segment(m.group(1), head_only)
        m = re.match(r'^/([\w-]+)\.m3u8$', path)
        if m:
            return self._serve_channel(m.group(1), parts.query, head_only)
        self._send(404, 'not found\n', head_only=head_only)

    # ---- 页面 / 列表 ----
    def _index(self, head_only):
        root = public_root(self.headers)
        text = (
            '====================================================\n'
            'ysp-live-lite 央视频直播网关运行中 (%s)\n'
            '基于 Gary\'s Club ysp-live 9.8 改造 · 非作者发布\n'
            '原作者社区: %s\n'
            '====================================================\n\n'
            '全频道订阅: %s/all.m3u\n'
            '系统健康度: %s/health\n'
            '实时诊断日志: %s/diag\n'
        ) % (__version__, AUTHOR_COMMUNITY, root, root, root)
        self._send(200, text, head_only=head_only)

    def _all_m3u(self, query, head_only):
        root = public_root(self.headers)
        target_group = urllib.parse.parse_qs(query).get('group', [None])[0]
        lines = [
            '#EXTM3U url-tvg="https://epg.zsdc.eu.org/t.xml.gz,https://epg.pw/xmltv/epg_CN.xml.gz" x-tvg-url="https://epg.zsdc.eu.org/t.xml.gz"',
            '#EXT-X-APTV-PREVIEW: FALSE',
            '#EXT-X-APTV-LATENCY: FALSE',
            '#EXT-X-APTV-LOGO: FALSE',
        ]
        for meta in global_channel_dir.unique_channels():
            if target_group and target_group not in meta['group']:
                continue
            attrs = ' tvg-id="%s" tvg-name="%s" tvg-logo="%s" group-title="%s"' % (
                meta['tvg_id'], meta['name'], meta['logo'], meta['group'])
            if meta['slug'] in TIMESHIFT_SUPPORTED:
                attrs += ' catchup="append" catchup-days="7" catchup-source="?playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}"'
            lines.append('#EXTINF:-1%s,%s' % (attrs, meta['name']))
            lines.append('%s/%s.m3u8' % (root, meta['slug']))
        self._send(200, '\n'.join(lines) + '\n', 'application/vnd.apple.mpegurl', head_only=head_only)

    def _health(self, head_only):
        gate = jce_request_gate.remaining()
        data = {
            'ok': True,
            'version': __version__,
            'mode': 'low-bitrate-only',
            'primary_mode': PRIMARY_MODE,
            'uptime_sec': int(time.time() - server_start_time),
            'channels': len(global_channel_dir.unique_channels()),
            'proxy_segments': PROXY_SEGMENTS,
            'jce_cooldown_sec': int(math.ceil(gate)) if gate > 0 else 0,
            'ts_cache': global_ts_cache.stats(),
        }
        self._send(200, json.dumps(data, ensure_ascii=False, indent=2), 'application/json; charset=utf-8', head_only=head_only)

    def _diag(self, head_only):
        now = time.time()
        gate = jce_request_gate.remaining()
        info = [
            '====================================================',
            'ysp-live-lite %s 诊断报告 (运行时间: %ds)' % (__version__, int(now - server_start_time)),
            "基于 Gary's Club ysp-live 9.8 改造 · 原作者社区: %s" % AUTHOR_COMMUNITY,
            '====================================================',
            '主取流通道: %s (失败自动切换备用通道)' % PRIMARY_MODE,
            '分片模式: %s' % ('VPS 中转 (YSP_PROXY_SEGMENTS=1)' if PROXY_SEGMENTS else '客户端直连 CDN'),
            'JCE 限流冷却: %s' % ('剩余 %d 秒' % int(math.ceil(gate)) if gate > 0 else '无'),
        ]
        if PROXY_SEGMENTS:
            c = global_ts_cache.stats()
            info.append('分片内存缓存: 条目=%s, 占用=%sMB, 命中率=%s (命中:%s/未中:%s)' % (
                c['count'], c['size_mb'], c['hit_rate'], c['hits'], c['misses']))
        info.append('--- 频道状态列表 ---')
        for meta in global_channel_dir.unique_channels():
            ch = CHANNEL_MAP.get(meta['slug'])
            age = '%ds前' % int(now - ch.last_ok) if ch and ch.last_ok else '从未拉取'
            mode = ch.mode if ch else 'idle'
            err = (ch.last_error if ch else '') or '无'
            info.append('%s (%s) 模式=%s 上次刷新=%s 错误=%s' % (meta['slug'], meta['name'], mode, age, err))
        if global_log_ring:
            info.append('--- 最近运行事件 (最新 30 条) ---')
            info.extend(list(global_log_ring)[-30:])
        self._send(200, '\n'.join(info) + '\n', head_only=head_only)

    # ---- 频道播放列表（仅低码路径：JCE → bkliveinfo） ----
    def _serve_channel(self, raw_slug, query, head_only):
        key = normalize_channel(raw_slug)
        canonical = ALIAS_MAP.get(key, key)
        ch = get_channel_instance(canonical)
        if not ch:
            return self._send(404, '未知频道\n', head_only=head_only)

        catchup = parse_catchup_query(query)
        if catchup and canonical in TIMESHIFT_SUPPORTED:
            start_ts, end_ts = catchup
            try:
                m3u8_url = jce_timeshift_url(ch.pid, ch.sid, start_ts, end_ts, ch.defn)
                return self._send_playlist(fetch_abs_playlist(m3u8_url), head_only)
            except Exception as e:
                log('[%s] 时移获取失败: %s，回退直播' % (canonical, e), min_interval=10.0)

        now_ts = time.time()
        if ch.mode == 'jce':
            jce_note_access(ch, now_ts)
        else:
            ch.last_access = now_ts
        with ch.lock:
            cached_pl = ch.last_built_playlist
            cached_age = now_ts - ch.last_built_time
        swr_max = 3.0 if ch.mode == 'bk' else 8.0
        swr_bg = 1.8 if ch.mode == 'bk' else 4.0
        if (cached_pl and cached_age < swr_max
                and (ch.mode != 'jce' or now_ts - getattr(ch, 'jce_live_media_end', 0) <= 30)
                and now_ts - ch.last_ok <= LOW_PLAYLIST_MAX_AGE
                and '#EXTM3U' in cached_pl):
            self._send_playlist(cached_pl, head_only, {'X-SWR': 'HIT'})
            if cached_age > swr_bg:
                trigger_background_refresh(ch)
            return

        ensure_channel(ch)
        pl = build_playlist(ch, holdback=True)
        if pl and '#EXTM3U' in pl:
            return self._send_playlist(pl, head_only)
        if cached_pl and cached_age < LOW_PLAYLIST_MAX_AGE * 2 and '#EXTM3U' in cached_pl:
            return self._send_playlist(cached_pl, head_only, {'X-SWR': 'STALE'})
        if ch.mode == 'jce':
            retry = max(jce_request_gate.remaining(), getattr(ch, 'jce_media_blocked_until', 0) - time.time())
            if retry > 0:
                return self._send(503, '低码率接口限流冷却中，请稍后重试\n', head_only=head_only,
                                  extra_headers={'Retry-After': str(max(1, math.ceil(retry)))})
        self._send(503, '频道 %s 暂无数据 (%s), 请稍后重试\n' % (ch.name, ch.last_error or '拉取中'), head_only=head_only)

    # ---- 分片中转 ----
    def _serve_segment(self, token, head_only):
        try:
            real_url = _b64d(token)
        except Exception:
            return self._send(400, 'bad segment token\n', head_only=head_only)
        if not seg_host_allowed(real_url):
            log('[中转] 拒绝非白名单域名: %s（如确认是央视 CDN，可用 YSP_SEG_ALLOW_EXTRA 追加）'
                % (urllib.parse.urlsplit(real_url).hostname or '?'), min_interval=30.0)
            return self._send(403, 'forbidden host\n', head_only=head_only)

        range_header = self.headers.get('Range', '').strip()
        if not _RANGE_RE.match(range_header):
            range_header = ''

        if not range_header and not head_only:
            hit = global_ts_cache.get(real_url)
            if hit is not None:
                data, hdrs = hit
                self.send_response(200)
                for k, v in hdrs.items():
                    if k.lower() != 'content-length':
                        self.send_header(k, v)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'public, max-age=60')
                self.send_header('X-Cache', 'HIT')
                self.end_headers()
                self._started = True
                self.wfile.write(data)
                return

        conn = None
        try:
            try:
                conn, resp = open_upstream(real_url, range_header, head_only)
            except PermissionError as e:
                log('[中转] 重定向到非白名单域名被拒绝: %s' % e, min_interval=30.0)
                return self._send(403, 'forbidden redirect\n', head_only=head_only)
            except Exception as e:
                log('[中转] 上游连接失败: %s: %s' % (type(e).__name__, e), min_interval=10.0)
                return self._send(502, 'upstream error\n', head_only=head_only)

            hdrs = {k: v for k, v in resp.getheaders() if k.lower() in _PASS_HEADERS}
            clen = resp.getheader('Content-Length')
            expected = int(clen) if clen and clen.isdigit() else None
            self.send_response(resp.status)
            for k, v in hdrs.items():
                self.send_header(k, v)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=60')
            self.send_header('X-Cache', 'MISS')
            if expected is None and not head_only:
                self.send_header('Connection', 'close')  # 长度未知，只能以关闭连接收尾
                self.close_connection = True
            self.end_headers()
            self._started = True
            if head_only:
                return

            cacheable = resp.status == 200 and not range_header and (expected is None or expected <= MAX_SEG_BYTES)
            buf = bytearray()
            sent = 0
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                sent += len(chunk)
                if cacheable:
                    if len(buf) + len(chunk) > MAX_SEG_BYTES:
                        cacheable = False
                        buf = bytearray()
                    else:
                        buf.extend(chunk)
            if expected is not None and sent != expected:
                self.close_connection = True  # 上游提前断流：别让客户端在这条连接上傻等
            elif cacheable and buf:
                global_ts_cache.set(real_url, bytes(buf), hdrs)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True
        except (http.client.HTTPException, OSError) as e:
            self.close_connection = True
            log('[中转] 分片传输中断: %s: %s' % (type(e).__name__, e), min_interval=10.0)
        finally:
            if conn is not None:
                conn.close()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128


class Server6(Server):
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)  # 双栈
        except (AttributeError, OSError):
            pass
        super().server_bind()


def main():
    global server_port
    ap = argparse.ArgumentParser(description='央视频直播网关（ysp-live-lite，VPS/Docker 低码精简版）')
    ap.add_argument('port', nargs='?', type=int, default=_env_int('YSP_PORT', 8767, 1, 65535), help='监听端口 (默认 8767)')
    ap.add_argument('--bind', default=os.environ.get('YSP_BIND', '').strip() or '0.0.0.0', help='监听地址 (默认 0.0.0.0，:: 为 IPv6 双栈)')
    args = ap.parse_args()

    if TOKEN and not TOKEN_RE.match(TOKEN):
        sys.exit('YSP_TOKEN 只允许 8~64 位的字母、数字、下划线、连字符，例如用 openssl rand -hex 16 生成。')
    server_port = args.port

    srv = (Server6 if ':' in args.bind else Server)((args.bind, args.port), Handler)

    def _stop(signum, frame):
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    total = len(global_channel_dir.unique_channels())
    cctv = len([c for c in global_channel_dir.unique_channels() if c['group'] == '央视'])
    log('=' * 68)
    log('ysp-live-lite %s 启动成功: %d 个频道 (央视 %d 路, 卫视 %d 路) · 低码率路径 (主通道: %s，失败自动切换备用)' % (
        __version__, total, cctv, total - cctv, PRIMARY_MODE))
    log('监听 %s:%d · 分片模式: %s · 缓存 %dMB' % (
        args.bind, args.port, 'VPS 中转' if PROXY_SEGMENTS else '客户端直连 CDN', CACHE_MB if PROXY_SEGMENTS else 0))
    log('订阅地址: %s/all.m3u' % ('http://<你的地址>:%d/<YSP_TOKEN>' % args.port if TOKEN else 'http://<你的地址>:%d' % args.port))
    if EXCLUDE_CHANNELS:
        log('已按 YSP_EXCLUDE_CHANNELS 屏蔽频道: %s' % ','.join(sorted(EXCLUDE_CHANNELS)))
    if not TOKEN:
        log('警告: 未设置 YSP_TOKEN，任何知道地址的人都能使用本服务并消耗你的 VPS 流量。公网部署请务必设置。')
    log("基于 Gary's Club ysp-live 9.8 改造 · 原作者社区: %s · 本改造版非作者发布" % AUTHOR_COMMUNITY)
    log('=' * 68)
    try:
        srv.serve_forever()
    finally:
        srv.server_close()
        log('[系统] 服务已停止')


if __name__ == '__main__':
    main()
