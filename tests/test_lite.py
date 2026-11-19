import hashlib, http.client, importlib.util, itertools, os, re, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'ysp-live-lite.py')
SEG_LEN = 300 * 1024
DUR = 4.0
fails = []


def check(name, cond, extra=''):
    print(('  PASS ' if cond else '  FAIL ') + name + (('  -> ' + str(extra)) if (extra and not cond) else ''))
    if not cond:
        fails.append(name)


def seg_bytes(n):
    return (hashlib.sha256(str(n).encode()).digest() * (SEG_LEN // 32 + 1))[:SEG_LEN]


# ---------------- 模拟 CDN ----------------
class CDN(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    hits = []

    def log_message(self, *a):
        pass

    def _body(self, code, data, ctype, extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        CDN.hits.append(self.path)
        p = self.path.split('?')[0]
        if p == '/live.m3u8':  # 带 PDT 的滚动窗口，分片对齐到 4 秒边界
            now = time.time()
            last_end = int(now // DUR) * DUR            # 最后一个已完成分片的结束时间
            first = last_end - 10 * DUR
            seq0 = int(first / DUR)
            lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:%d' % seq0]
            for i in range(10):
                st = first + i * DUR
                import datetime
                pdt = datetime.datetime.fromtimestamp(st, datetime.timezone.utc).isoformat(timespec='milliseconds')
                lines += ['#EXT-X-PROGRAM-DATE-TIME:' + pdt, '#EXTINF:4.000,', 'seg/%d.ts' % (seq0 + i)]
            return self._body(200, ('\n'.join(lines) + '\n').encode(), 'application/vnd.apple.mpegurl')
        if p == '/bk.m3u8':  # 备用通道：无 PDT 的普通列表 + 一个 KEY 标签用来测 URI 绝对化
            txt = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-KEY:METHOD=NONE,URI="key/1.key"\n'
            for i in range(100, 105):
                txt += '#EXTINF:4.0,\nseg/%d.ts\n' % i
            return self._body(200, txt.encode(), 'application/vnd.apple.mpegurl')
        m = re.match(r'^/seg/(\d+)\.ts$', p)
        if m:
            data = seg_bytes(int(m.group(1)))
            rng = self.headers.get('Range')
            if rng:
                a, b = re.match(r'bytes=(\d*)-(\d*)$', rng).groups()
                a = int(a or 0); b = int(b) if b else len(data) - 1
                return self._body(206, data[a:b + 1], 'video/mp2t',
                                  {'Content-Range': 'bytes %d-%d/%d' % (a, b, len(data)), 'Accept-Ranges': 'bytes'})
            return self._body(200, data, 'video/mp2t', {'Accept-Ranges': 'bytes'})
        if p == '/nolen.ts':  # 不带 Content-Length，靠关闭连接收尾
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp2t')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            self.wfile.write(seg_bytes(9))
            return
        if p == '/redir.ts':
            self.send_response(302); self.send_header('Location', '/seg/7.ts'); self.send_header('Content-Length', '0'); self.end_headers(); return
        if p == '/redir_bad.ts':
            self.send_response(302); self.send_header('Location', 'http://example.com/x.ts'); self.send_header('Content-Length', '0'); self.end_headers(); return
        if p == '/notfound.ts':
            return self._body(404, b'nope', 'text/plain')
        self._body(404, b'nope', 'text/plain')


cdn = ThreadingHTTPServer(('127.0.0.1', 0), CDN)
cdn.daemon_threads = True
CDN_PORT = cdn.server_address[1]
threading.Thread(target=cdn.serve_forever, daemon=True).start()
CDN_BASE = 'http://127.0.0.1:%d' % CDN_PORT
_counter = itertools.count()


def load_app(env):
    """按给定环境变量导入一份全新的模块，并把上游网络调用指向模拟 CDN。"""
    for k in ('YSP_TOKEN', 'YSP_PUBLIC_URL', 'YSP_PROXY_SEGMENTS', 'YSP_CACHE_MB', 'YSP_SEG_ALLOW_EXTRA', 'YSP_EXCLUDE_CHANNELS', 'YSP_PRIMARY_MODE', 'YSP_FORCE_IPV4', 'YSP_UPSTREAM_PROXY'):
        os.environ.pop(k, None)
    os.environ.update(env)
    spec = importlib.util.spec_from_file_location('ysp_lite_%d' % next(_counter), SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.jce_timeshift_url = lambda *a, **k: CDN_BASE + '/live.m3u8'
    mod.bk_playurls = lambda *a, **k: [CDN_BASE + '/bk.m3u8']
    mod.SEG_ALLOWED_SUFFIXES = ('.127.0.0.1',)  # 测试里把本机当作白名单 CDN
    srv = mod.Server(('127.0.0.1', 0), mod.Handler)
    mod.server_port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return mod, srv, srv.server_address[1]


def get(port, path, headers=None, method='GET', conn=None):
    c = conn or http.client.HTTPConnection('127.0.0.1', port, timeout=20)
    c.request(method, path, headers=headers or {})
    r = c.getresponse()
    body = r.read()
    if conn is None:
        c.close()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, body


TOKEN = 'abcDEF1234567890'

# ===================== A. 口令 + 直连模式 =====================
print('A. 口令 + 直连 CDN 模式')
mod, srv, port = load_app({'YSP_TOKEN': TOKEN, 'YSP_PRIMARY_MODE': 'jce'})
st, h, b = get(port, '/healthz'); check('/healthz 无需口令', st == 200 and b == b'ok\n')
for p in ('/', '/all.m3u', '/cctv1.m3u8', '/health', '/diag', '/WRONGTOKEN123/all.m3u', '/' + TOKEN[:-1] + '/all.m3u'):
    st, *_ = get(port, p); check('无/错口令 404: ' + p, st == 404)
st, h, b = get(port, '/%s/all.m3u' % TOKEN)
txt = b.decode()
entries = re.findall(r'^http://[^\n]+\.m3u8$', txt, re.M)
check('all.m3u 200 且有 64 个频道', st == 200 and len(entries) == 64, (st, len(entries)))
check('频道链接带口令前缀', all(('/%s/' % TOKEN) in e for e in entries))
check('默认保留 4K/8K 频道条目（走 1080p 低码路径）', 'cctv4k' in txt and 'cctv8k' in txt)
check('catchup 追加参数不会与口令冲突', 'catchup-source="?playseek=' in txt)
st, h, b = get(port, '/%s/all.m3u' % TOKEN, {'X-Forwarded-Proto': 'https', 'Host': 'tv.example.com'})
check('反代头生效 https://tv.example.com/<token>/', 'https://tv.example.com/%s/cctv1.m3u8' % TOKEN in b.decode())
st, h, b = get(port, '/%s/all.m3u' % TOKEN, {'Host': 'evil host\x20x<>'}); check('异常 Host 被忽略不回显', 'evil' not in b.decode())
st, h, b = get(port, '/%s/all.m3u?group=%%E5%%8D%%AB%%E8%%A7%%86' % TOKEN)
check('group=卫视 过滤', st == 200 and 'cctv1.m3u8' not in b.decode() and 'bjws.m3u8' in b.decode())

t0 = time.time()
st, h, b = get(port, '/%s/cctv1.m3u8' % TOKEN)
pl = b.decode()
segs = [l for l in pl.splitlines() if l and not l.startswith('#')]
check('cctv1.m3u8 200 + 有效 HLS', st == 200 and pl.startswith('#EXTM3U') and len(segs) >= 4, (st, pl[:200]))
check('直连模式：分片是 CDN 绝对地址', all(s.startswith(CDN_BASE + '/seg/') for s in segs), segs[:2])
check('Content-Type 为 HLS', h.get('content-type') == 'application/vnd.apple.mpegurl')
st, h2, b2 = get(port, '/%s/cctv1.m3u8' % TOKEN)
check('第二次请求命中缓存 (X-SWR: HIT)', st == 200 and h2.get('x-swr') == 'HIT', h2)
check('CDN 只被取了很少几次(去重/缓存)', len([x for x in CDN.hits if x.startswith('/live.m3u8')]) <= 3, CDN.hits)
st, h, b = get(port, '/%s/cctv1.m3u8?playseek=20261119100000-20261119110000' % TOKEN)
check('时移回看入口 200', st == 200 and b.decode().startswith('#EXTM3U'), (st, b[:100]))
st, *_ = get(port, '/%s/nosuchchannel.m3u8' % TOKEN); check('未知频道 404', st == 404)
st, h, b = get(port, '/%s/health' % TOKEN)
check('/health 不含 guid/设备字段', st == 200 and b'guid' not in b and b'device' not in b and b'"proxy_segments": false' in b, b[:200])
st, h, b = get(port, '/%s/diag' % TOKEN); check('/diag 可用且含频道状态', st == 200 and 'cctv1' in b.decode() and '设备' not in b.decode())
st, *_ = get(port, '/%s/seg/AAAAAAAAAAAA.ts' % TOKEN); check('直连模式下 /seg 404', st == 404)
st, *_ = get(port, '/%s/engine_proxy?url=http://x' % TOKEN); check('/engine_proxy 已移除', st == 404)
st, *_ = get(port, '/%s/proxy.ts?token=x' % TOKEN); check('/proxy.ts 已移除', st == 404)
st, h, b = get(port, '/%s/cctv1.m3u8' % TOKEN, method='HEAD'); check('HEAD m3u8 200 无 body', st == 200 and b == b'')
# keep-alive: 同一连接连发多个请求
c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
ok = True
for _ in range(5):
    st, h, b = get(port, '/%s/all.m3u' % TOKEN, conn=c); ok &= (st == 200)
check('HTTP/1.1 keep-alive 同连接连发 5 个请求', ok)
c.close()
srv.shutdown()

# ===================== B. 备用通道(bk) =====================
print('B. bkliveinfo 备用通道')
mod, srv, port = load_app({})   # 无口令
st, h, b = get(port, '/cctv11.m3u8')
pl = b.decode()
check('cctv11(bk) 200 + 有效 HLS', st == 200 and pl.startswith('#EXTM3U'), (st, pl[:150]))
check('bk 分片/KEY 均被转成绝对地址', CDN_BASE + '/seg/100.ts' in pl and 'URI="%s/key/1.key"' % CDN_BASE in pl, pl)
st, h, b = get(port, '/all.m3u'); check('无口令模式链接不带前缀', 'http://127.0.0.1:%d/cctv1.m3u8' % port in b.decode())
srv.shutdown()

# ===================== C. 中转模式 =====================
print('C. 分片中转模式')
mod, srv, port = load_app({'YSP_TOKEN': TOKEN, 'YSP_PROXY_SEGMENTS': '1', 'YSP_CACHE_MB': '8', 'YSP_PRIMARY_MODE': 'jce'})
st, h, b = get(port, '/%s/cctv1.m3u8' % TOKEN)
pl = b.decode()
segs = [l for l in pl.splitlines() if l and not l.startswith('#')]
check('中转模式：分片地址改写为 /<token>/seg/…ts', st == 200 and segs and all(('/%s/seg/' % TOKEN) in s and s.endswith('.ts') for s in segs), segs[:2])
check('播放列表其余标签保持', '#EXT-X-MEDIA-SEQUENCE:' in pl and '#EXT-X-PROGRAM-DATE-TIME:' in pl)
seg_path = re.sub(r'^https?://[^/]+', '', segs[0])
real_seq = int(re.search(r'seg/(\d+)\.ts', mod._b64d(re.search(r'/seg/([^/]+?)\.ts$', segs[0]).group(1))).group(1))
st, h, b = get(port, seg_path)
check('分片中转 200 且字节一致', st == 200 and b == seg_bytes(real_seq) and h.get('x-cache') == 'MISS', (st, h, len(b)))
check('Content-Length 正确', h.get('content-length') == str(SEG_LEN))
n_before = len([x for x in CDN.hits if '/seg/%d.ts' % real_seq in x])
st, h, b = get(port, seg_path)
n_after = len([x for x in CDN.hits if '/seg/%d.ts' % real_seq in x])
check('第二次命中内存缓存，不再回源', st == 200 and h.get('x-cache') == 'HIT' and b == seg_bytes(real_seq) and n_after == n_before, (h, n_before, n_after))
st, h, b = get(port, seg_path, {'Range': 'bytes=100-199'})
check('Range 请求 206 且内容正确', st == 206 and b == seg_bytes(real_seq)[100:200] and h.get('content-range', '').startswith('bytes 100-199/'), (st, h))
st, h, b = get(port, seg_path, method='HEAD'); check('HEAD 分片 200 无 body', st == 200 and b == b'')
tok = lambda u: '/%s/seg/%s.ts' % (TOKEN, mod._b64e(u))
st, h, b = get(port, tok(CDN_BASE + '/nolen.ts'))
check('上游无 Content-Length：照常转发并关闭连接', st == 200 and b == seg_bytes(9) and h.get('connection') == 'close', (st, h, len(b)))
st, h, b = get(port, tok(CDN_BASE + '/redir.ts'))
check('服务端跟随白名单内重定向', st == 200 and b == seg_bytes(7), (st, len(b)))
st, h, b = get(port, tok(CDN_BASE + '/redir_bad.ts')); check('重定向到非白名单域名 403', st == 403, st)
st, h, b = get(port, tok('http://example.com/seg.ts')); check('非白名单域名 403', st == 403, st)
st, h, b = get(port, tok('http://169.254.169.254/latest/meta-data/')); check('云元数据地址 403（SSRF）', st == 403, st)
st, h, b = get(port, tok('http://127.0.0.1.evil.com/x.ts')); check('域名后缀伪造 403', st == 403, st)
st, h, b = get(port, tok('file:///etc/passwd')); check('file:// 403', st == 403, st)
st, h, b = get(port, tok(CDN_BASE + '/notfound.ts')); check('上游 404 原样透传', st == 404, st)
st, h, b = get(port, '/%s/seg/!!!notbase64.ts' % TOKEN); check('非法 token 不崩溃(4xx)', st in (400, 404), st)
st, h, b = get(port, '/WRONGTOKEN123/seg/%s.ts' % mod._b64e(CDN_BASE + '/seg/1.ts')); check('错误口令不能用中转', st == 404, st)
c = http.client.HTTPConnection('127.0.0.1', port, timeout=10); ok = True
for i in range(4):
    st, h, b = get(port, seg_path, conn=c); ok &= (st == 200 and b == seg_bytes(real_seq))
check('中转分片 keep-alive 同连接连发', ok); c.close()
# 并发
res = []
def w():
    s, _, bb = get(port, seg_path); res.append(s == 200 and bb == seg_bytes(real_seq))
ts = [threading.Thread(target=w) for _ in range(20)]
[t.start() for t in ts]; [t.join() for t in ts]
check('20 并发取同一分片全部正确', all(res) and len(res) == 20, res)
st, h, b = get(port, '/%s/cctv11.m3u8' % TOKEN)
check('bk 播放列表在中转模式下 KEY URI 也被中转', 'URI="http://127.0.0.1:%d/%s/seg/' % (port, TOKEN) in b.decode(), b.decode()[:300])
st, h, b = get(port, '/%s/health' % TOKEN); check('health 反映缓存统计', b'"proxy_segments": true' in b and b'"hits"' in b)
srv.shutdown()

# ===================== D. 频道屏蔽 + 对外地址 =====================
print('D. YSP_EXCLUDE_CHANNELS / YSP_PUBLIC_URL')
mod, srv, port = load_app({'YSP_EXCLUDE_CHANNELS': 'cctv4k, cctv8k,cctv164k', 'YSP_PUBLIC_URL': 'https://tv.example.com/', 'YSP_TOKEN': TOKEN})
st, h, b = get(port, '/%s/all.m3u' % TOKEN); txt = b.decode()
check('屏蔽后剩 61 个频道', len(re.findall(r'^https://[^\n]+\.m3u8$', txt, re.M)) == 61)
check('PUBLIC_URL 覆盖且去掉末尾斜杠', 'https://tv.example.com/%s/cctv1.m3u8' % TOKEN in txt and 'cctv4k' not in txt)
st, *_ = get(port, '/%s/cctv4k.m3u8' % TOKEN); check('被屏蔽频道 404', st == 404)
st, *_ = get(port, '/%s/cctv16-4k.m3u8' % TOKEN); check('被屏蔽频道的别名也 404', st == 404)
srv.shutdown()

# ===================== E. 真实进程：启动、口令校验、SIGTERM =====================
print('E. 真实进程')
env = dict(os.environ); [env.pop(k, None) for k in list(env) if k.startswith('YSP_')]
r = subprocess.run([sys.executable, SRC, '18999'], env={**env, 'YSP_TOKEN': 'short'}, capture_output=True, text=True, timeout=20)
check('非法 YSP_TOKEN 拒绝启动', r.returncode != 0 and 'YSP_TOKEN' in (r.stderr + r.stdout), r)
p = subprocess.Popen([sys.executable, SRC, '18998'], env={**env, 'YSP_TOKEN': TOKEN}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(1.5)
st, h, b = get(18998, '/healthz'); check('子进程监听并响应 /healthz', st == 200)
st, h, b = get(18998, '/%s/all.m3u' % TOKEN); check('子进程 all.m3u 200', st == 200 and b.count(b'.m3u8') == 64)
t0 = time.time(); p.terminate()
try:
    rc = p.wait(timeout=8)
except subprocess.TimeoutExpired:
    p.kill(); rc = 'timeout'
out = p.stdout.read()
check('SIGTERM 优雅退出(code 0, <3s)', rc == 0 and time.time() - t0 < 3, (rc, time.time() - t0))
check('启动日志含口令警告以外的关键信息且不打印口令', TOKEN not in out and '低码率路径' in out and '基于' in out, out[:500])
p = subprocess.Popen([sys.executable, SRC, '18997'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(1.2); p.terminate(); p.wait(timeout=8); out = p.stdout.read()
check('未设口令时打印醒目警告', '未设置 YSP_TOKEN' in out)

# ===================== F. 503 修复回归测试（双向容灾 / 休眠线程立即重试 / 过期快速刷新） =====================
print('F. 503 修复回归测试')
# F1: 默认主通道为 bk，且 bk 失败时自动回退到 jce
mod, srv, port = load_app({'YSP_TOKEN': TOKEN})
check('默认主通道为 bk', mod.PRIMARY_MODE == 'bk' and mod.CHANNEL_MAP['cctv1'].mode == 'bk')
st, h, b = get(port, '/%s/cctv1.m3u8' % TOKEN)
check('默认 bk 模式下 cctv1 正常返回 200', st == 200 and b.decode().startswith('#EXTM3U'), (st, b[:120]))
mod.bk_playurls = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('bk down'))
st, h, b = get(port, '/%s/cctv2.m3u8' % TOKEN)
check('bk 异常时自动回退 jce 返回 200', st == 200 and b.decode().startswith('#EXTM3U') and mod.CHANNEL_MAP['cctv2'].mode == 'jce', (st, b[:120]))
srv.shutdown()

# F2: jce 模式下任意异常（非 DeadHostError，如 403/超严格解析失败）自动回退到 bk
mod, srv, port = load_app({'YSP_TOKEN': TOKEN, 'YSP_PRIMARY_MODE': 'jce'})
mod.jce_timeshift_url = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('HTTP 403 Forbidden'))
st, h, b = get(port, '/%s/cctv1.m3u8' % TOKEN)
check('jce 任意异常时自动回退 bk 返回 200', st == 200 and b.decode().startswith('#EXTM3U') and mod.CHANNEL_MAP['cctv1'].mode == 'bk', (st, b[:120]))
srv.shutdown()

# F3: 后台线程存活但处于休眠且缓存过期时，ensure_channel 仍会立即拉取而不是秒回 503
mod, srv, port = load_app({'YSP_TOKEN': TOKEN})
ch = mod.CHANNEL_MAP['cctv1']
ch.thread = threading.Thread(target=lambda: time.sleep(5), daemon=True)
ch.thread.start()
ch.last_ok = 0.0
ch.bk_playlist = ''
st, h, b = get(port, '/%s/cctv1.m3u8' % TOKEN)
check('后台线程存活休眠且无缓存时立即拉取返回 200', st == 200 and b.decode().startswith('#EXTM3U'), (st, b[:120]))
srv.shutdown()

print()
print('FAILED: %d' % len(fails) if fails else 'ALL PASSED')
sys.exit(1 if fails else 0)
