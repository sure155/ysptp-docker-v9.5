// ============================================================
// ysp-live IPTV 直播网关 (Cloudflare Worker, 单文件)  v11.5.1
// 基于实测流畅的 v11.3 架构精简优化 (原生 BK 直通 + 60s 后台同源热续期)
// ============================================================
// 环境变量 (均可选):
//   TOKEN        访问口令, 设置后所有路径(除 / 和 favicon)都需 ?token=xxx
//   LIVE_MODE    auto(默认) | bk | jce
//                auto: 默认走 bk 原生直播流直通 (除 CCTV-8K 外), 仅当冷启动 bk 不可用时才用 JCE 兜底
//                bk  : 所有频道只走 bk
//                jce : 所有频道(除 FORCE_BK 外)走 JCE
//   PROXY_TS     设为 1 时默认通过 Worker 代理 .ts 分片 (也可在订阅/频道 URL 加 ?proxy=1)
//   NATIVE_GZIP  设为 1 时 JCE 请求使用 CompressionStream 压缩 (默认用 stored-gzip)
//   GUID         32 位 hex, 固定设备 ID (不设则每个 isolate 随机生成)
//   CATCHUP_TZ   回看时间字符串(yyyyMMddHHmmss)所用时区, 默认 +08:00
//                可填 +08:00 / utc / IANA 名(如 Asia/Shanghai) / auto(取访问者 IP 时区)
//   CATCHUP_MAX  单次回看最长跨度(秒), 默认 14400 (4 小时), 范围 600~43200
//   PDT_OVERLAP_MAX  容许相邻分片 PDT 重叠的最大秒数, 默认 1.2, 范围 0.05~3
//
// v11.5.0 说明 (回归 v11.3 流畅直通架构, 仅做 4 项轻量级防断连修正):
//   1. 回归 v11.3 的 bk 原生 m3u8 直通 (absolutize), 移除 v12 中会导致播放器卡住的列表重写与 JCE 主通路切换
//   2. 解决 bk Token 过期断流: bkliveinfo 签发的 atime=120 Token 约 2 分钟过期 (v11.3 缓存 4 分钟过长, v11.4 锁死旧 URL
//      导致过期 403); 现改为满 60 秒后台静默预刷新地址池、满 85 秒强制换用新 Token 地址, 始终在过期前平滑交接
//   3. 同域名优先选源: 地址池刷新换用新 Token 时, 优先挑选与上一轮相同 CDN 域名 (lastHost) 的新地址,
//      既拿到全新 Token 又保持落点在同一台上游打包服务器上, 保证 MEDIA-SEQUENCE 连续不跳变
//   4. 禁止播放中途切 JCE + 2.5 秒快速切备用源: 播放中途遇瞬时网络抖动用旧列表兜底并在下一轮重试 bk,
//      绝不在中途切到 JCE 造成断流; 单次 m3u8 拉取超时设为 2.5 秒以便在单次轮询内快速切到备用地址
//
// v11.5.1 说明 (基于 v11.5.0 精细打磨防偶发黑屏/断连, 不改动主架构):
//   1. 提前 Token 续期边界: BK_PREFETCH_MS=45s, BK_URL_TTL=70s, 共享缓存 65s, 给 .ts 下载与缓冲留足余量
//   2. 放宽热更新窗口: FRESH_MAX=18s, SYNC_WAIT_MS=3.2s, P_MAX=15s, 避免 6s 轮询掉入 10s 冷启动等待
//   3. 分片代理防截断: /seg 超时提升至 15s, 防止高码率 FHD/4K 分片传输中途被超时中断
//   4. 防边缘节点序号倒退与无谓切源: 同域名 MEDIA-SEQUENCE 小幅倒退不覆盖, 遇 401/403/410 立即刷池, 瞬时失败保留 lastHost
// ============================================================

// ---------------- channels ----------------
// [slug, 名称, sid, pid, 清晰度]
const CH_TABLE = [
  ["cctv1", "CCTV-1 综合", "2024078201", "600001859", "fhd"],
  ["cctv2", "CCTV-2 财经", "2024075401", "600001800", "fhd"],
  ["cctv3", "CCTV-3 综艺", "2024068501", "600001801", "fhd"],
  ["cctv4", "CCTV-4 中文国际", "2029797101", "600001814", "fhd"],
  ["cctv5", "CCTV-5 体育", "2024078401", "600001818", "fhd"],
  ["cctv5p", "CCTV-5+ 体育赛事", "2024078001", "600001817", "fhd"],
  ["cctv6", "CCTV-6 电影", "2013693901", "600108442", "fhd"],
  ["cctv7", "CCTV-7 国防军事", "2024072001", "600004092", "fhd"],
  ["cctv8", "CCTV-8 电视剧", "2029793001", "600001803", "fhd"],
  ["cctv9", "CCTV-9 纪录", "2024078601", "600004078", "fhd"],
  ["cctv10", "CCTV-10 科教", "2024078701", "600001805", "fhd"],
  ["cctv11", "CCTV-11 戏曲", "2027248701", "600001806", "fhd"],
  ["cctv12", "CCTV-12 社会与法", "2027248801", "600001807", "fhd"],
  ["cctv13", "CCTV-13 新闻", "2029797201", "600001811", "fhd"],
  ["cctv14", "CCTV-14 少儿", "2027248901", "600001809", "fhd"],
  ["cctv15", "CCTV-15 音乐", "2027249001", "600001815", "fhd"],
  ["cctv16", "CCTV-16 奥林匹克", "2027249101", "600098637", "fhd"],
  ["cctv164k", "CCTV-16 4K", "2027249301", "600099502", "fhd"],
  ["cctv17", "CCTV-17 农业农村", "2027249401", "600001810", "fhd"],
  ["cctv4k", "CCTV-4K 超高清", "2029810301", "600002264", "fhd"],
  ["cctv8k", "CCTV-8K 超高清", "2026774101", "600156816", "fhd"],
  ["cgtn", "CGTN", "2024181701", "600014550", "fhd"],
  ["cgtnfr", "CGTN 法语", "2024181801", "600084704", "fhd"],
  ["cgtnru", "CGTN 俄语", "2024181901", "600084758", "fhd"],
  ["cgtnar", "CGTN 阿拉伯语", "2024182001", "600084782", "fhd"],
  ["cgtnes", "CGTN 西班牙语", "2024182101", "600084744", "fhd"],
  ["cgtndoc", "CGTN 纪录", "2024182301", "600084781", "fhd"],
  ["cctvfyjc", "CCTV 风云剧场", "2025637102", "600099658", "shd"],
  ["cctvdyjc", "CCTV 第一剧场", "2026874202", "600099655", "shd"],
  ["cctvhjjc", "CCTV 怀旧剧场", "2026874302", "600099620", "shd"],
  ["bjws", "北京卫视", "2024052703", "600002309", "fhd"],
  ["jsws", "江苏卫视", "2024171103", "600002521", "fhd"],
  ["dfws", "东方卫视", "2024054503", "600002483", "fhd"],
  ["zjws", "浙江卫视", "2024054703", "600002520", "fhd"],
  ["hnws", "湖南卫视", "2024054803", "600002475", "fhd"],
  ["hbws", "湖北卫视", "2024171203", "600002508", "fhd"],
  ["gdws", "广东卫视", "2024060903", "600002485", "fhd"],
  ["gxws", "广西卫视", "2024060703", "600002509", "fhd"],
  ["hljws", "黑龙江卫视", "2029797003", "600002498", "fhd"],
  ["hainanws", "海南卫视", "2024055603", "600002506", "fhd"],
  ["cqws", "重庆卫视", "2024061103", "600002531", "fhd"],
  ["szws", "深圳卫视", "2024061303", "600002481", "fhd"],
  ["scws", "四川卫视", "2024061403", "600002516", "fhd"],
  ["henanws", "河南卫视", "2029797303", "600002525", "fhd"],
  ["dnws", "东南卫视", "2024061503", "600002484", "fhd"],
  ["gzws", "贵州卫视", "2024061603", "600002490", "fhd"],
  ["jxws", "江西卫视", "2024061703", "600002503", "fhd"],
  ["lnws", "辽宁卫视", "2024171303", "600002505", "fhd"],
  ["ahws", "安徽卫视", "2024171403", "600002532", "fhd"],
  ["hebws", "河北卫视", "2024171503", "600002493", "fhd"],
  ["sdws", "山东卫视", "2029787903", "600002513", "fhd"],
  ["tjws", "天津卫视", "2019927003", "600152137", "fhd"],
  ["jlws", "吉林卫视", "2025561503", "600190405", "fhd"],
  ["saxws", "陕西卫视", "2029795103", "600190400", "fhd"],
  ["nxws", "宁夏卫视", "2025608503", "600190737", "fhd"],
  ["nmgws", "内蒙古卫视", "2025561203", "600190401", "fhd"],
  ["ynws", "云南卫视", "2025561303", "600190402", "fhd"],
  ["shanxiws", "山西卫视", "2025560803", "600190407", "fhd"],
  ["gsws", "甘肃卫视", "2025561703", "600190408", "fhd"],
  ["qhws", "青海卫视", "2025559103", "600190406", "fhd"],
  ["xizangws", "西藏卫视", "2025558003", "600190403", "fhd"],
  ["xjws", "新疆卫视", "2019927403", "600152138", "fhd"],
  ["cetv1", "CETV-1", "2022823801", "600171827", "fhd"],
  ["guoxue", "国学频道", "2029360403", "600213139", "fhd"],
];
const CHANNELS = CH_TABLE.map(([slug, name, sid, pid, defn]) => ({ slug, name, sid, pid, defn }));

const ALIAS_MAP = { "anhuiws": "ahws", "beijingws": "bjws", "cctv16hd": "cctv16", "cctv5plus": "cctv5p", "cctvdiyijuchang": "cctvdyjc", "cctvfengyunjuchang": "cctvfyjc", "cctvhuaijiujuchang": "cctvhjjc", "cgtnalaboyu": "cgtnar", "cgtneyu": "cgtnru", "cgtnfayu": "cgtnfr", "cgtnwaiyujilu": "cgtndoc", "cgtnxibanyayu": "cgtnes", "chongqingws": "cqws", "dongfangws": "dfws", "fujiandongnanws": "dnws", "guangdongws": "gdws", "guangxiws": "gxws", "guizhouws": "gzws", "hebeiws": "hebws", "heilongjiangws": "hljws", "hubeiws": "hbws", "hunanws": "hnws", "jiangsuws": "jsws", "jiangxiws": "jxws", "jilinws": "jlws", "liaoningws": "lnws", "neimengguws": "nmgws", "ningxiaws": "nxws", "qinghaiws": "qhws", "shandongws": "sdws", "shannxiws": "saxws", "shaanxiws": "saxws", "shenzhenws": "szws", "sichuanws": "scws", "tianjinws": "tjws", "xinjiangws": "xjws", "yunnanws": "ynws", "zhejiangws": "zjws" };

const TVG_IDS = { "cctv1": "CCTV1", "cctv2": "CCTV2", "cctv3": "CCTV3", "cctv4": "CCTV4", "cctv5": "CCTV5", "cctv5p": "CCTV5+", "cctv6": "CCTV6", "cctv7": "CCTV7", "cctv8": "CCTV8", "cctv9": "CCTV9", "cctv10": "CCTV10", "cctv11": "CCTV11", "cctv12": "CCTV12", "cctv13": "CCTV13", "cctv14": "CCTV14", "cctv15": "CCTV15", "cctv16": "CCTV16", "cctv164k": "CCTV16", "cctv17": "CCTV17", "cctv4k": "CCTV4K", "cctv8k": "CCTV-8K", "cgtn": "CGTN英语", "cgtnfr": "CGTN法语", "cgtnru": "CGTN俄语", "cgtnar": "CGTN阿语", "cgtnes": "CGTN西语", "cgtndoc": "CGTN纪录", "cctvdyjc": "CCTV第一剧场", "cctvfyjc": "CCTV风云剧场", "cctvhjjc": "CCTV怀旧剧场", "cetv1": "CETV1", "bjws": "北京卫视", "jsws": "江苏卫视", "dfws": "东方卫视", "zjws": "浙江卫视", "hnws": "湖南卫视", "hbws": "湖北卫视", "gdws": "广东卫视", "gxws": "广西卫视", "hljws": "黑龙江卫视", "hainanws": "海南卫视", "cqws": "重庆卫视", "szws": "深圳卫视", "scws": "四川卫视", "henanws": "河南卫视", "dnws": "东南卫视", "gzws": "贵州卫视", "jxws": "江西卫视", "lnws": "辽宁卫视", "ahws": "安徽卫视", "hebws": "河北卫视", "sdws": "山东卫视", "tjws": "天津卫视", "jlws": "吉林卫视", "saxws": "陕西卫视", "nxws": "宁夏卫视", "nmgws": "内蒙古卫视", "ynws": "云南卫视", "shanxiws": "山西卫视", "qhws": "青海卫视", "xizangws": "西藏卫视", "xjws": "新疆卫视", "gsws": "甘肃卫视", "guoxue": "国学" };

const TIMESHIFT_SUPPORTED = new Set(["ahws", "bjws", "cctv1", "cctv10", "cctv13", "cctv2", "cctv3", "cctv4", "cctv5", "cctv5p", "cctv6", "cctv7", "cctv8", "cctv8k", "cctv9", "cetv1", "cgtn", "cgtnar", "cgtndoc", "cgtnes", "cgtnfr", "cgtnru", "cqws", "dfws", "dnws", "gdws", "gsws", "guoxue", "gxws", "gzws", "hainanws", "hbws", "hebws", "henanws", "hljws", "hnws", "jlws", "jsws", "jxws", "lnws", "nmgws", "nxws", "qhws", "saxws", "scws", "sdws", "shanxiws", "szws", "tjws", "xizangws", "xjws", "ynws", "zjws"]);
const FORCE_BK = new Set(["cctv11", "cctv12", "cctv14", "cctv15", "cctv16", "cctv164k", "cctv17", "cctv4k", "cctvdyjc", "cctvfyjc", "cctvhjjc"]);
const FORCE_JCE = new Set(["cctv8k"]);
const TRUE_4K = new Set(["cctv164k", "cctv4k", "cctv8k"]);

// ---------------- JCE / cKey (协议层) ----------------
const te = new TextEncoder();
const td = new TextDecoder();
const VER_NAME = "3.2.7.26212";
const VER_CODE = "302070";
const APP_ID = "1200013";
const QMF_APP_ID = 10012;
const QMF_PLATFORM = 1;
const BIZ_ID = 0n;
const CHAN_ID = "10070";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const u32be = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

let GUID = "";
let MID = null;
let REQ_SEQ = 0;
function initGuid(seed) {
  if (GUID) return;
  GUID = /^[0-9a-f]{32}$/i.test(seed || "") ? seed.toLowerCase() : hex(rnd(16));
  MID = null;
}

class W {
  constructor() { this.b = []; }
  _push(u8) { for (const x of u8) this.b.push(x); }
  head(typ, tag) {
    if (tag < 15) this.b.push(((tag & 15) << 4) | (typ & 15));
    else { this.b.push(240 | (typ & 15)); this.b.push(tag); }
  }
  byte(v, tag) {
    v = Number(v);
    if (v === 0) this.head(12, tag);
    else { this.head(0, tag); this.b.push(v & 255); }
  }
  short(v, tag) {
    v = Number(v);
    if (v >= -128 && v <= 127) this.byte(v, tag);
    else { this.head(1, tag); this.b.push((v >> 8) & 255, v & 255); }
  }
  int(v, tag) {
    v = Number(v);
    if (v >= -32768 && v <= 32767) this.short(v, tag);
    else { this.head(2, tag); this.b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
  }
  long(v, tag) {
    const n = BigInt(v);
    if (n >= -2147483648n && n <= 2147483647n) this.int(Number(n), tag);
    else {
      this.head(3, tag);
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigInt64(0, n);
      this._push(buf);
    }
  }
  float(v, tag) {
    this.head(4, tag);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v);
    this._push(b);
  }
  double(v, tag) {
    this.head(5, tag);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v);
    this._push(b);
  }
  string(s, tag) {
    if (s === null || s === undefined) return;
    const d = te.encode(String(s));
    if (d.length > 255) { this.head(7, tag); this._push(u32be(d.length)); }
    else { this.head(6, tag); this.b.push(d.length); }
    this._push(d);
  }
  bytes(data, tag) {
    this.head(13, tag);
    this.head(0, 0);
    this.int(data.length, 0);
    this._push(data);
  }
  struct(fn, tag) {
    this.head(10, tag);
    fn(this);
    this.head(11, 0);
  }
  list(items, tag) {
    this.head(9, tag);
    this.int(items.length, 0);
  }
  out() { return Uint8Array.from(this.b); }
}

class R {
  constructor(data) {
    this.d = data;
    this.p = 0;
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  rem() { return this.d.length - this.p; }
  get(n) {
    if (this.p + n > this.d.length) throw new Error("EOF");
    const s = this.d.subarray(this.p, this.p + n);
    this.p += n;
    return s;
  }
  u8() { return this.get(1)[0]; }
  head() {
    const b = this.u8();
    const typ = b & 15;
    let tag = (b & 240) >> 4;
    if (tag === 15) tag = this.u8();
    return [typ, tag];
  }
  value(typ) {
    switch (typ) {
      case 0: return this.dv.getInt8((this.p += 1) - 1);
      case 1: return this.dv.getInt16((this.p += 2) - 2);
      case 2: return this.dv.getInt32((this.p += 4) - 4);
      case 3: return Number(this.dv.getBigInt64((this.p += 8) - 8));
      case 4: return this.dv.getFloat32((this.p += 4) - 4);
      case 5: return this.dv.getFloat64((this.p += 8) - 8);
      case 6: { const n = this.u8(); return td.decode(this.get(n)); }
      case 7: { const n = this.dv.getInt32((this.p += 4) - 4); return td.decode(this.get(n)); }
      case 8: {
        const n = this._int();
        const m = new Map();
        for (let i = 0; i < n; i++) m.set(this._fv(), this._fv());
        return m;
      }
      case 9: {
        const n = this._int();
        const a = [];
        for (let i = 0; i < n; i++) a.push(this._fv());
        return a;
      }
      case 10: return this.struct();
      case 11: return null;
      case 12: return 0;
      case 13: { this.head(); const n = this._int(); return this.get(n); }
      default: throw new Error("jce type " + typ);
    }
  }
  _fv() { const [t] = this.head(); return this.value(t); }
  _int() { const [t] = this.head(); return Number(this.value(t)); }
  struct() {
    const m = new Map();
    while (this.rem() > 0) {
      const [t, tag] = this.head();
      if (t === 11) break;
      m.set(tag, this.value(t));
    }
    return m;
  }
}

function qua(w) {
  w.string(VER_NAME, 0);
  w.string(VER_CODE, 1);
  w.int(1080, 2);
  w.int(2400, 3);
  w.int(3, 4);
  w.string("12", 5);
  w.int(1, 6);
  w.int(1, 7);
  w.int(420, 8);
  w.string(CHAN_ID, 9);
  for (let i = 10; i < 15; i++) w.string("", i);
  w.struct((ww) => { ww.int(0, 0); ww.byte(0, 1); ww.string("", 2); }, 15);
  w.string("", 16);
  w.string("", 17);
  w.string("", 18);
  w.struct((ww) => { ww.int(0, 0); ww.float(0, 1); ww.float(0, 2); ww.double(0, 3); }, 19);
  w.string(GUID.slice(0, 16), 20);
  w.string("Pixel 6", 21);
  w.int(1, 22);
  for (let i = 23; i < 27; i++) w.int(0, i);
  w.string("", 27);
  w.string("", 28);
  w.string(GUID, 29);
}

function headStruct(w, cmd, reqid) {
  if (!MID) {
    const t = new W();
    t.struct((ww) => qua(ww), 2);
    t.string(APP_ID, 3);
    t.string(GUID, 4);
    t.list([], 5);
    t.struct(() => {}, 6);
    t.list([], 7);
    t.int(0, 8);
    t.int(0, 9);
    t.int(0, 10);
    MID = t.out();
  }
  w.int(reqid, 0);
  w.int(cmd, 1);
  w._push(MID);
}

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (u8) => {
  let c = 4294967295;
  for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 4294967295) >>> 0;
};

const opts = { nativeGzip: false };
async function gzipNative(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
function gzipStored(u8) {
  const n = u8.length;
  if (n > 65535) throw new Error("gzipStored: too large");
  const out = new Uint8Array(10 + 5 + n + 8);
  const dv = new DataView(out.buffer);
  out.set([31, 139, 8, 0, 0, 0, 0, 0, 0, 255], 0);
  out[10] = 1;
  dv.setUint16(11, n, true);
  dv.setUint16(13, ~n & 65535, true);
  out.set(u8, 15);
  dv.setUint32(15 + n, crc32(u8), true);
  dv.setUint32(19 + n, n, true);
  return out;
}
async function gunzip(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function wrap(cmd, body, reqid) {
  const w = new W();
  w.struct((ww) => headStruct(ww, cmd, reqid), 0);
  w.bytes(body, 1);
  const reqcmd = w.out();
  const inner = concat(Uint8Array.of(38), u32be(reqcmd.length + 17), Uint8Array.of(1), new Uint8Array(10), reqcmd, Uint8Array.of(40));
  const comp = opts.nativeGzip ? await gzipNative(inner) : gzipStored(inner);
  const head = new Uint8Array(89);
  const dv = new DataView(head.buffer);
  let o = 0;
  head[o++] = 19;
  dv.setInt32(o, 0); o += 4;
  dv.setUint16(o, 2); o += 2;
  dv.setUint16(o, 65281); o += 2;
  dv.setUint16(o, cmd); o += 2;
  dv.setUint16(o, 0); o += 2;
  dv.setBigInt64(o, BigInt(reqid)); o += 8;
  dv.setInt32(o, 531); o += 4;
  dv.setInt32(o, QMF_APP_ID); o += 4;
  dv.setBigInt64(o, BIZ_ID); o += 8;
  head.set(te.encode(GUID).subarray(0, 32), o); o += 32;
  dv.setInt8(o, QMF_PLATFORM); o += 1;
  dv.setInt32(o, parseInt(VER_CODE, 10)); o += 4;
  o += 6;
  head[o++] = 0;
  dv.setUint16(o, 0); o += 2;
  dv.setUint16(o, 0); o += 2;
  dv.setInt32(o, inner.length); o += 4;
  if (o !== 89) throw new Error("header size " + o);
  const out = concat(head, comp, Uint8Array.of(3));
  new DataView(out.buffer).setInt32(1, out.length);
  return out;
}

async function unwrap(data) {
  if (data[0] !== 19 || data.length < 90) return null;
  const flags = new DataView(data.buffer, data.byteOffset).getInt32(21);
  let payload = data.subarray(89, data.length - 1);
  if (flags & 2) payload = await gunzip(payload);
  if (payload[0] !== 38 || payload[payload.length - 1] !== 40) return null;
  const rc = new R(payload.subarray(16, payload.length - 1)).struct();
  return rc.get(1) || new Uint8Array(0);
}

// 向 JACC 申请时移 m3u8 地址 (回看 / CCTV-8K 使用)
async function jceTimeshiftUrl(pid, sid, start, end, stream = "fhd", timeout = 6000) {
  const w = new W();
  w.string(pid, 0);
  w.string(sid, 1);
  w.long(start, 2);
  w.long(end, 3);
  w.string(stream, 4);
  const reqid = (Date.now() + REQ_SEQ++) & 2147483647;
  const packet = await wrap(25312, w.out(), reqid);

  const resp = await fetch("https://jacc.ysp.cctv.cn", {
    method: "POST",
    body: packet,
    headers: { "Content-Type": "application/octet-stream" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) {
    const e = new Error("jacc HTTP " + resp.status);
    e.status = resp.status;
    e.retryAfter = resp.headers.get("Retry-After");
    throw e;
  }
  const raw = new Uint8Array(await resp.arrayBuffer());
  const body = await unwrap(raw);
  if (!body || !body.length) throw new Error("bad response");
  const m = new R(body).struct();
  const err = m.get(0) ?? 0;
  if (err !== 0) throw new Error(m.get(1) || "errCode=" + err);
  const url = m.get(2) || "";
  if (!url) throw new Error("empty m3u8");
  if (url.includes("liverecord.video.cloud.cctv.com")) {
    const e = new Error("dead cdn host");
    e.dead = true;
    e.host = "liverecord.video.cloud.cctv.com";
    throw e;
  }
  return url;
}

// ---- cKey ----
const CK_PLATFORM = 4330403;
const CK_APPVER = "V8.22.1035.3031";
const CK_TEA = unhex("59b2f7cf725ef43c34fdd7c123411ed3");
const CK_GTEA = unhex("110DBEC10C23E7D2E56A1CAD6914EF1B");
const CK_XOR = Uint8Array.from([132, 46, 237, 8, 240, 102, 230, 234, 72, 180, 202, 169, 145, 237, 111, 243]);
const CK_GXOR = Uint8Array.from([179, 201, 83, 160, 105, 19, 173, 77]);

const keyWords = (k) => {
  const v = new DataView(k.buffer, k.byteOffset, 16);
  return [v.getUint32(0), v.getUint32(4), v.getUint32(8), v.getUint32(12)];
};
const KW = new Map([[CK_TEA, keyWords(CK_TEA)], [CK_GTEA, keyWords(CK_GTEA)]]);

function cksum(buf) {
  let v = 0;
  for (let i = 0; i < buf.length; i++) v = (131 * v + buf[i]) & 2147483647;
  return v;
}

function teaPkt(data, key, rand = rnd) {
  const pad = (8 - (data.length + 10) % 8) % 8;
  const plain = concat(Uint8Array.of((rand(1)[0] & 248) | pad), rand(pad), rand(2), data, new Uint8Array(7));
  const [k0, k1, k2, k3] = KW.get(key) || keyWords(key);
  const pv = new DataView(plain.buffer, plain.byteOffset, plain.length);
  const out = new Uint8Array(plain.length);
  const ov = new DataView(out.buffer);
  let pp0 = 0, pp1 = 0, pc0 = 0, pc1 = 0;
  for (let off = 0; off < plain.length; off += 8) {
    const m0 = (pv.getUint32(off) ^ pc0) >>> 0, m1 = (pv.getUint32(off + 4) ^ pc1) >>> 0;
    let y = m0, z = m1, s = 0;
    for (let i = 0; i < 16; i++) {
      s = (s + 2654435769) >>> 0;
      y = (y + ((((z << 4) + k0) >>> 0 ^ (z + s) >>> 0 ^ ((z >>> 5) + k1) >>> 0) >>> 0)) >>> 0;
      z = (z + ((((y << 4) + k2) >>> 0 ^ (y + s) >>> 0 ^ ((y >>> 5) + k3) >>> 0) >>> 0)) >>> 0;
    }
    const c0 = (y ^ pp0) >>> 0, c1 = (z ^ pp1) >>> 0;
    ov.setUint32(off, c0);
    ov.setUint32(off + 4, c1);
    pp0 = m0; pp1 = m1; pc0 = c0; pc1 = c1;
  }
  return out;
}

const lp = (s) => {
  const d = typeof s === "string" ? te.encode(s) : s;
  const h = new Uint8Array(2);
  new DataView(h.buffer).setUint16(0, d.length);
  return concat(h, d);
};

function ckGuard(ts, guid, rand = rnd) {
  const tail = (v) => { const t = String(v); return t.length >= 5 ? t.slice(-5) : ""; };
  const body = concat(u32be(ts), lp(tail(guid)), lp(tail("null")), lp(tail("null")), lp("-1"));
  const plain = lp(body);
  const enc = concat(teaPkt(plain, CK_GTEA, rand), u32be(cksum(plain)));
  for (let i = 0; i < enc.length; i++) enc[i] ^= CK_GXOR[i & 7];
  return hex(enc).toUpperCase();
}

function ckey(channelId, rand = rnd, nowSec = Math.floor(Date.now() / 1e3)) {
  const ts = nowSec;
  const guid = hex(rand(16));
  const guard = ckGuard(ts, guid, rand);
  const uid = hex(rand(4)).toUpperCase();
  const body = concat(
    unhex("0000004200000004000004d2"),
    u32be(CK_PLATFORM),
    u32be(0),
    u32be(ts),
    lp("dcgh"),
    lp("_zj1A5Gh6QYcxWjIUGos2w=="),
    lp(CK_APPVER),
    lp(String(channelId)),
    lp(guid),
    u32be(1),
    u32be(1),
    lp(uid),
    lp("nil"),
    lp("57eab0c4-2c58-44c6-8ae9-dd2757525dc5"),
    lp("nil"),
    lp("v0.1.000"),
    lp("com.cctv.yangshipin.app.iphone"),
    lp(String(CK_PLATFORM)),
    lp("ex_json_bus"),
    lp("ex_json_vs"),
    lp(guard)
  );
  const lenH = new Uint8Array(2);
  new DataView(lenH.buffer).setUint16(0, body.length);
  const pkt = concat(lenH, body);
  pkt.set(u32be(cksum(pkt)), 18);
  const enc = concat(teaPkt(pkt, CK_TEA, rand), u32be(cksum(pkt)));
  for (let i = 0; i < enc.length; i++) enc[i] ^= CK_XOR[i & 15];
  const b64 = btoa(String.fromCharCode(...enc)).replace(/\+/g, "_").replace(/\//g, "-").replace(/=+$/, "");
  const flowId = crypto.randomUUID().replace(/-/g, "").toUpperCase() + "_" + CK_PLATFORM;
  return { cKey: "--01" + b64, guid, ts, flowId };
}

// 向 bkliveinfo 申请真直播流地址
const BK_H264 = btoa("H(30:1080,60:1080|30:1080,60:1080)");
async function bkPlayUrls(channelId, livePid, defn = "fhd") {
  const t = ckey(channelId);
  const q = new URLSearchParams({
    atime: "120",
    livepid: livePid,
    cnlid: channelId,
    appVer: CK_APPVER,
    app_version: "300090",
    caplv: "1",
    cmd: "2",
    defn,
    device: "iPhone",
    encryptVer: "4.2",
    getpreviewinfo: "0",
    hevclv: "0",
    lang: "zh-Hans_CN",
    livequeue: "0",
    logintype: "1",
    nettype: "1",
    newnettype: "1",
    newplatform: String(CK_PLATFORM),
    platform: String(CK_PLATFORM),
    sdtfrom: "v3021",
    spacode: "23",
    spaudio: "1",
    spdemuxer: "6",
    spdrm: "2",
    spdynamicrange: "1",
    spflv: "1",
    spflvaudio: "1",
    sphdrfps: "60",
    sphttps: "1",
    spvcode: BK_H264,
    spvideo: "4",
    stream: "1",
    system: "1",
    sysver: "ios18.2.1",
    uhd_flag: "0",
    cKey: t.cKey,
    guid: t.guid,
    fntick: String(t.ts),
    flowid: t.flowId,
    playbacktime: "0",
  });

  const r = await fetch("https://bkliveinfo.ysp.cctv.cn/?" + q, {
    cf: { cacheTtl: 0 },
    headers: { "User-Agent": "qqlive", Accept: "application/json" },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) {
    const e = new Error("bkliveinfo HTTP " + r.status);
    e.status = r.status;
    e.retryAfter = r.headers.get("Retry-After");
    throw e;
  }
  const p = await r.json();
  if (Number(p.iretcode ?? -1) !== 0) throw new Error(`iretcode=${p.iretcode} ${p.errinfo || ""}`);
  let urls = [];
  if (p.playurl) urls.push(p.playurl);
  const bu = p.backurl_list || p.backurlList || p.backurl;
  if (Array.isArray(bu)) for (const it of bu) urls.push(typeof it === "string" ? it : it.url || it.playurl || "");
  else if (typeof bu === "string") urls.push(...bu.split(/[;,]/).filter((x) => x.trim()));
  urls = [...new Set(urls)].filter((u) => u && u.includes(".cctv."));
  if (!urls.length) throw new Error("no playurl");
  // 按去掉动态查询参数后的 (bklive优先 + 域名路径) 确定性排序, 保证多实例选出同一主 CDN 域名
  const baseKey = (u) => String(u).split("?")[0].replace(/^https?:\/\//i, "");
  urls.sort((a, b) => (a.includes("bklive-") ? 0 : 1) - (b.includes("bklive-") ? 0 : 1) || baseKey(a).localeCompare(baseKey(b)));
  return urls;
}

// ---------------- 网关主体 ----------------
const VERSION = "11.5.1-cf-opt";
const UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const H_JCE = { "User-Agent": UA_BROWSER, Accept: "*/*" };
const H_BK = { "User-Agent": "qqlive", Referer: "https://live.cctv.cn/", Accept: "application/vnd.apple.mpegurl,application/json,*/*" };
const LOGO_BASE = "https://garysclub.sharewithyou.dpdns.org/logos/ysp-live-logos";

// ---- 直播参数 ----
const LIVE_BACK = 120;
const LIVE_AHEAD = 900;
const ANCHOR_BUCKET = 180;
const ANCHOR_MARGIN = 60;
const JACC_GAP_MS = 600;
const JACC_QUEUE_MAX = 10000;
const JACC_TIMEOUT = 7000;
const MEDIA_TIMEOUT = 7000;
const THROTTLE_MIN = 45;
const THROTTLE_MAX = 600;
const BK_GAP_MS = 250;           // bkliveinfo 接口请求最小间隔 (+ 0~150ms 抖动)
const BK_JITTER_MS = 150;
const BK_PREFETCH_MS = 45000;    // bk 地址池满 45 秒即在后台静默预刷新新 Token (给 .ts 缓冲与下载留足余量)
const BK_URL_TTL = 70000;        // bk 地址池硬有效期 70 秒 (确保始终使用未过期的新 Token 地址)
const BK_TIMEOUT = 2500;         // bk 单次拉取 m3u8 超时 2.5 秒 (超时立即切池内备用地址)
const STICKY_MS = 600000;
const FRESH_MAX = 18;
const REFRESH_AFTER = 1.2;       // 列表超过 1.2 秒即同步刷新拉取新分片
const SYNC_WAIT_MS = 3200;       // 已有旧缓存时, 同步等待新列表的最长时间 (ms)
const LOW_PLAYLIST_MAX_AGE = 35; // 上游瞬时抖动时旧列表最大兜底秒数(防止偶发超时直接报 503 断连)
const LOW_IDLE = 45;
const COLD_WAIT_MS = 10000;
const P_MAX = 15000;
const CU_PEND_MAX = 60000;
const FETCH_TIMEOUT = 6000;

// ---- 回看专用参数 ----
const CU_JACC_TIMEOUT = 8000;
const CU_FETCH_TIMEOUT = 12000;
const CU_CHUNK = 3600;
const CU_PARALLEL = 3;
const CU_CACHE_TTL = 300000;
const CU_BUDGET = 16000;

const CH = new Map(CHANNELS.map((c) => [c.slug, c]));
const cfg = { mode: "auto", tz: 480, max: 14400, origin: "", overlapMax: 1.2, proxyTs: false, token: "" };
const LIVE = new Map();
const gate = { next: 0, blockedUntil: 0, penalty: 0, last: null };
const bkGate = { next: 0, blockedUntil: 0 };
const cuCache = new Map();
const reqLog = [];
const liveLog = [];
const liveSeen = new Map();
let liveHits = 0;
const maskQ = (q) => q.replace(/([?&]token=)[^&?]*/gi, "$1***");
const pushLog = (list, e, max) => { list.push(e); if (list.length > max) list.shift(); };

const CORS = { "Access-Control-Allow-Origin": "*" };
const M3U8 = "application/vnd.apple.mpegurl";
const reply = (body, status = 200, type = "text/plain; charset=utf-8", extra = {}) =>
  new Response(body, { status, headers: { "Content-Type": type, "Cache-Control": "no-cache, no-store, max-age=0", ...CORS, ...extra } });
const errMsg = (e) => String((e && e.message) || e);
const stripQ = (u) => String(u).split("?")[0];
const hostOf = (u) => { try { return new URL(u).host; } catch { return "?"; } };

const groupOf = (slug) => (slug.startsWith("cctv") || slug.startsWith("cgtn") ? "央视" : "卫视");
const normalize = (raw) => {
  let k = raw.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  if (k.endsWith(".m3u8")) k = k.slice(0, -5);
  if (["cctv16-4k", "cctv16_4k", "cctv16/4k", "cctv16(4k)"].includes(k)) return "cctv164k";
  return ALIAS_MAP[k] || k;
};

// ---- 回看参数 ----
const zoneOk = (z) => { try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return true; } catch { return false; } };

function parseTz(v, dflt) {
  if (v === null || v === undefined || String(v).trim() === "") return dflt;
  const raw = String(v).trim();
  const s = raw.toLowerCase();
  if (s === "utc" || s === "z" || s === "gmt") return 0;
  const m = s.match(/^([+-]?)(\d{1,2})(?::?(\d{2}))?$/);
  if (m) return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +(m[3] || 0));
  if (/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/.test(raw) && zoneOk(raw)) return raw;
  return dflt;
}

function tzOffsetMin(zone, utcMs) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const p = {};
  for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

function wallToEpoch(y, mo, d, h, mi, s, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  if (typeof tz === "number") return Math.floor((wall - tz * 60000) / 1000);
  const g = wall - tzOffsetMin(tz, wall) * 60000;
  return Math.floor((wall - tzOffsetMin(tz, g) * 60000) / 1000);
}

function parseTimeVal(v, tz) {
  if (!v) return null;
  const raw = String(v).trim();
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return +d;
  if (d.length === 13) return Math.floor(+d / 1e3);
  if (d.length === 14 || d.length === 12) {
    const s = d.length === 12 ? d + "00" : d;
    const mo = +s.slice(4, 6), dd = +s.slice(6, 8);
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
    const t = wallToEpoch(+s.slice(0, 4), mo, dd, +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14), /gmt|z$/i.test(raw) ? 0 : tz);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const fmtBJ = (t) => new Date((t + 28800) * 1e3).toISOString().replace("T", " ").slice(0, 19) + " (UTC+8)";

function parseCatchup(sp, defaultTz = 480, maxSpan = 14400, autoTz = null) {
  const now = Math.floor(Date.now() / 1e3);
  const tzRaw = sp.get("tz");
  const tz = tzRaw && tzRaw.trim().toLowerCase() === "auto" ? parseTz(autoTz, defaultTz) : parseTz(tzRaw, defaultTz);
  let start = null, end = null;
  const ps = sp.get("playseek") || sp.get("tvdr");
  if (ps) {
    const nums = ps.match(/\d{10,14}/g) || [];
    const z = /gmt|z\b/i.test(ps) ? "Z" : "";
    if (nums.length >= 2) { start = parseTimeVal(nums[0] + z, tz); end = parseTimeVal(nums[1] + z, tz); }
    else if (nums.length === 1) start = parseTimeVal(nums[0] + z, tz);
  }
  const g = (k) => parseTimeVal(sp.get(k), tz);
  start ??= g("utc") ?? g("start") ?? g("starttime") ?? g("begin") ?? g("timestamp");
  end ??= g("utcend") ?? g("end") ?? g("endtime") ?? g("lutc");
  if (start == null) return null;
  if (start >= now - 15) {
    if (start > now + 300) return { bad: `回看起点 ${fmtBJ(start)} 在未来, 疑似时区不对: 请设置环境变量 CATCHUP_TZ=auto, 或在 URL 加 &tz=<你设备的时区>, 或改用 /all.m3u?mode=utc`, tz };
    return null;
  }
  const dur = parseInt(String(sp.get("duration") || sp.get("dur") || "").replace(/\D/g, ""), 10);
  if ((end == null || end <= start) && dur > 0 && dur <= maxSpan) end = start + dur;
  if (end == null || end <= start) end = start + maxSpan;
  end = Math.min(end, now, start + maxSpan);
  return { start, end, open: end >= now - 90, tz };
}

// ---- 上游抓取 / 播放列表工具 ----
// 注意: Cloudflare Workers 不支持 fetch({ cache: "no-store" }), 必须用 cf: { cacheTtl: 0 } 禁用边缘子请求缓存
async function fetchText(url, headers, timeout = FETCH_TIMEOUT) {
  const r = await fetch(url, {
    headers,
    cf: { cacheTtl: 0 },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) {
    let host = "";
    try { host = " @" + new URL(url).host; } catch {}
    throw new Error(`HTTP ${r.status}${host}`);
  }
  return { text: await r.text(), final: r.url || url };
}

const absUri = (base, ref) => (/^https?:\/\//i.test(ref) ? ref : new URL(ref, base).toString());
const absTagUri = (line, base) => line.replace(/URI="([^"]*)"/g, (_, u) => `URI="${absUri(base, u)}"`);

const SAFE_REL = /^[A-Za-z0-9_][A-Za-z0-9_\-./?=&%+,;~*!'()$@]*$/;
function resolver(base) {
  let dir = null;
  try { const u = new URL(base); dir = u.origin + u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1); } catch {}
  return (ref) => {
    if (/^https?:\/\//i.test(ref)) return ref;
    if (dir && SAFE_REL.test(ref) && !ref.includes("./") && !ref.includes(":")) return dir + ref;
    return new URL(ref, base).toString();
  };
}

// 可选分片代理重写
function wrapProxyUrl(targetUrl, mode = "bk") {
  const tk = cfg.token ? `&token=${encodeURIComponent(cfg.token)}` : "";
  return `${cfg.origin}/seg?m=${mode}${tk}&u=${encodeURIComponent(targetUrl)}`;
}
function rewritePlaylistProxy(playlist, mode = "bk") {
  const out = [];
  for (const ln of playlist.split(/\r?\n/)) {
    const s = ln.trim();
    if (!s) { out.push(ln); continue; }
    if (s[0] === "#") {
      out.push(s.includes('URI="') ? ln.replace(/URI="([^"]+)"/g, (_, u) => `URI="${/^https?:\/\//i.test(u) ? wrapProxyUrl(u, mode) : u}"`) : ln);
    } else if (/^https?:\/\//i.test(s)) {
      out.push(wrapProxyUrl(s, mode));
    } else {
      out.push(ln);
    }
  }
  return out.join("\n");
}

async function fetchMediaPlaylist(url, headers, depth = 0, timeout = FETCH_TIMEOUT) {
  const { text, final } = await fetchText(url, headers, timeout);
  if (!text.includes("#EXTM3U")) throw new Error("not an m3u8 @" + hostOf(final));
  if (depth < 2 && text.includes("#EXT-X-STREAM-INF")) {
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => l.trim().startsWith("#EXT-X-STREAM-INF"));
    for (let j = i + 1; j < lines.length; j++) {
      const s = lines[j].trim();
      if (s && !s.startsWith("#")) return fetchMediaPlaylist(absUri(final, s), headers, depth + 1, timeout);
    }
  }
  return { text, final };
}

async function fetchPlaylistAny(url, headerSets, timeout) {
  let last;
  for (const h of headerSets) {
    try { return await fetchMediaPlaylist(url, h, 0, timeout); }
    catch (e) { last = e; if (e && e.name === "TimeoutError") break; }
  }
  throw last;
}

function absolutize(text, base, isCatchup = false) {
  const abs = resolver(base);
  const out = [];
  let ended = false;
  for (const ln of text.split(/\r?\n/)) {
    const s = ln.trim();
    if (!s) { out.push(ln); continue; }
    if (s[0] === "#") {
      if (isCatchup && s.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) continue;
      if (s === "#EXT-X-ENDLIST") ended = true;
      out.push(s.includes('URI="') ? absTagUri(s, base) : ln);
    } else out.push(abs(s));
  }
  let r = out.join("\n");
  if (isCatchup && !ended) r += "\n#EXT-X-ENDLIST\n";
  return r;
}

function parseMedia(text, base) {
  const abs = resolver(base);
  const segs = [];
  let cur = { dur: 6, pdt: "", disc: false };
  let key = "", map = "";
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l[0] !== "#") {
      segs.push({ dur: cur.dur, pdt: cur.pdt, disc: cur.disc, key, map, url: abs(l) });
      cur = { dur: 6, pdt: "", disc: false };
    } else if (l.startsWith("#EXTINF:")) cur.dur = parseFloat(l.slice(8)) || 6;
    else if (l.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) cur.pdt = l.slice(25).trim();
    else if (l === "#EXT-X-DISCONTINUITY") cur.disc = true;
    else if (l.startsWith("#EXT-X-KEY:")) key = absTagUri(l, base);
    else if (l.startsWith("#EXT-X-MAP:")) map = absTagUri(l, base);
  }
  return segs;
}

const sumDur = (segs) => segs.reduce((a, s) => a + s.dur, 0);

function renderVod(segs) {
  let target = 1;
  for (const s of segs) target = Math.max(target, Math.ceil(s.dur));
  const out = ["#EXTM3U", `#EXT-X-VERSION:${segs.some((s) => s.map) ? 6 : 3}`, `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
  let key = "", map = "";
  for (const s of segs) {
    if (s.disc) out.push("#EXT-X-DISCONTINUITY");
    if (s.map && s.map !== map) { out.push(s.map); map = s.map; }
    if (s.key && s.key !== key) { out.push(s.key); key = s.key; }
    out.push(`#EXTINF:${s.dur.toFixed(3)},`, s.url);
  }
  out.push("#EXT-X-ENDLIST");
  return out.join("\n") + "\n";
}

// ============================================================
// 直播引擎 —— 回归 v11.3 原生直通架构 + 60s 后台同域名 Token 热续期
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (p, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(false); });
});

class RateLimited extends Error {
  constructor(msg, retrySec) { super(msg); this.name = "RateLimited"; this.retry = Math.max(1, Math.ceil(retrySec || 1)); }
}
class Reopen extends Error { constructor(msg, retryNow = false) { super(msg); this.name = "Reopen"; this.retryNow = retryNow; } }

// ---- 跨实例共享的小记录 (Cache API, 尽力而为) ----
const sharedReq = (name) => new Request(`${cfg.origin}/__ysp_state/${name}`);
async function sharedGet(name) {
  try {
    if (typeof caches === "undefined" || !cfg.origin) return null;
    const r = await caches.default.match(sharedReq(name));
    return r ? await r.json() : null;
  } catch { return null; }
}
async function sharedPut(name, obj, ttlSec) {
  try {
    if (typeof caches === "undefined" || !cfg.origin || !(ttlSec > 0)) return;
    await caches.default.put(sharedReq(name), new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${Math.ceil(ttlSec)}` } }));
  } catch {}
}
async function sharedDel(name) {
  try {
    if (typeof caches === "undefined" || !cfg.origin) return;
    await caches.default.delete(sharedReq(name));
  } catch {}
}
async function sharedProbe() {
  try {
    if (typeof caches === "undefined" || !cfg.origin) return false;
    const k = "probe-" + Math.random().toString(36).slice(2, 8);
    await sharedPut(k, { ok: 1 }, 30);
    const v = await sharedGet(k);
    return !!(v && v.ok === 1);
  } catch { return false; }
}

// ---- JACC 闸门 ----
const RATE_RE = /操作过于频繁|请求过于频繁|too many requests|rate limit/i;
const gateRemainingSec = () => Math.max(0, (gate.blockedUntil - Date.now()) / 1000);
function parseRetryAfter(h) {
  if (!h) return 0;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return n;
  const t = Date.parse(h);
  return Number.isNaN(t) ? 0 : Math.max(0, (t - Date.now()) / 1000);
}
async function noteThrottle(retryAfter, detail, channel) {
  gate.penalty = Math.min(THROTTLE_MAX, Math.max(THROTTLE_MIN, gate.penalty * 2));
  const delay = Math.max(gate.penalty, parseRetryAfter(retryAfter));
  gate.blockedUntil = Math.max(gate.blockedUntil, Date.now() + delay * 1000);
  gate.last = { at: new Date().toISOString(), channel: channel || null, detail: String(detail || "").replace(/\s+/g, " ").slice(0, 120), retryAfter: retryAfter || null };
  await sharedPut("cooldown", { until: gate.blockedUntil, penalty: gate.penalty, last: gate.last }, delay + 5);
  return new RateLimited(`JCE 请求被上游限流 (${gate.last.detail}), 暂停 ${Math.round(gateRemainingSec())} 秒`, gateRemainingSec());
}
async function loadSharedCooldown() {
  if (gate.blockedUntil > Date.now()) return;
  const c = await sharedGet("cooldown");
  if (c && c.until > Date.now()) {
    gate.blockedUntil = Math.max(gate.blockedUntil, c.until);
    gate.penalty = Math.max(gate.penalty, c.penalty || 0);
    if (c.last) gate.last = c.last;
  }
}
async function jaccCall(fn, active, channel) {
  await loadSharedCooldown();
  if (gateRemainingSec() > 0) throw new RateLimited(`JCE 限流冷却中, 剩余 ${Math.round(gateRemainingSec())} 秒`, gateRemainingSec());
  const now = Date.now();
  const slot = Math.max(now, gate.next);
  if (slot - now > JACC_QUEUE_MAX) throw new Error("JCE 请求排队过长, 请稍后重试");
  gate.next = slot + JACC_GAP_MS;
  if (slot > now) await sleep(slot - now);
  if (active && !active()) throw new Error("频道已空闲, 取消排队中的请求");
  if (gateRemainingSec() > 0) throw new RateLimited(`JCE 限流冷却中, 剩余 ${Math.round(gateRemainingSec())} 秒`, gateRemainingSec());
  try {
    const r = await fn();
    gate.penalty = 0;
    return r;
  } catch (e) {
    if (e && e.status === 429) throw await noteThrottle(e.retryAfter, `HTTP 429${e.retryAfter ? " Retry-After=" + e.retryAfter : ""}`, channel);
    if (RATE_RE.test(errMsg(e))) throw await noteThrottle(null, `业务错误: ${errMsg(e)}`, channel);
    throw e;
  }
}
const jaccUrl = (ch, start, end, defn, timeout, active) =>
  jaccCall(() => jceTimeshiftUrl(ch.pid, ch.sid, start, end, defn, timeout), active, ch.slug);

async function bkSlot() {
  if (bkGate.blockedUntil > Date.now()) throw new RateLimited("bk 通路限流冷却中", (bkGate.blockedUntil - Date.now()) / 1000);
  const now = Date.now();
  const slot = Math.max(now, bkGate.next);
  if (slot - now > JACC_QUEUE_MAX) throw new Error("bk 请求排队过长, 请稍后重试");
  bkGate.next = slot + BK_GAP_MS + Math.random() * BK_JITTER_MS;
  if (slot > now) await sleep(slot - now);
}

// ---- 每频道直播状态 ----
function liveState(ch) {
  let st = LIVE.get(ch.slug);
  if (!st) {
    const defaultMode = FORCE_JCE.has(ch.slug) ? "jce" : "bk";
    st = {
      mode: defaultMode, stickyUntil: 0,
      anchor: null,
      accepted: "", offset: 0,
      rows: new Map(),
      tail: null, target: null, suppressPdt: false, precise: null,
      playlist: "", builtAt: 0, mediaEnd: 0, lastOk: 0, lastAccess: 0,
      mediaBlockedUntil: 0,
      lastError: "", lastErr: null, fails: 0, retryAt: 0,
      inflight: null, inflightAt: 0,
      bk: { urls: [], t: 0, lastTail: "", lastHost: "", lastSeq: -1, refreshing: false },
    };
    LIVE.set(ch.slug, st);
  }
  return st;
}
function resetContinuity(st) {
  st.rows = new Map(); st.tail = null; st.target = null; st.accepted = ""; st.suppressPdt = false;
  st.playlist = ""; st.builtAt = 0; st.mediaEnd = 0; st.lastOk = 0;
}
async function invalidateAnchor(ch, st) {
  st.anchor = null;
  await sharedDel("anchor-" + ch.slug);
}
function effectiveMode(ch, st) {
  if (FORCE_BK.has(ch.slug) || cfg.mode === "bk") return "bk";
  if (FORCE_JCE.has(ch.slug)) return "jce";
  const isIdle = Date.now() / 1000 - st.lastAccess >= LOW_IDLE;
  if (cfg.mode === "jce") {
    if (st.mode === "bk" && st.stickyUntil && Date.now() > st.stickyUntil && isIdle) {
      st.mode = "jce"; st.stickyUntil = 0; resetContinuity(st);
    }
    return st.mode === "bk" && st.stickyUntil ? "bk" : "jce";
  }
  // auto 模式: 默认优先走 bk 真直播流; 若冷启动降级到了 jce, 仅在频道空闲后回切 bk
  if (st.mode === "jce" && st.stickyUntil && Date.now() > st.stickyUntil && isIdle) {
    st.mode = "bk"; st.stickyUntil = 0; resetContinuity(st);
  }
  return st.mode;
}

// ---- JCE 播放列表解析 (仅供 CCTV-8K 或显式 LIVE_MODE=jce 使用) ----
const PDT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
function parsePdt(v, info) {
  const m = PDT_RE.exec(String(v).trim());
  if (!m) throw new Error("JCE invalid PDT");
  const [, y, mo, d, h, mi, sec, frac, tz] = m;
  if (info && frac) info.frac = true;
  let off = 28800;
  if (tz) {
    if (tz.toUpperCase() === "Z") off = 0;
    else {
      const t = tz.replace(":", "");
      off = (t[0] === "-" ? -1 : 1) * (+t.slice(1, 3) * 3600 + +(t.slice(3, 5) || 0) * 60);
    }
  }
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec) / 1000 + (frac ? Number("0." + frac) : 0) - off;
}

function parseJceWindow(text, base, nowSec) {
  const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length || lines[0] !== "#EXTM3U") throw new Error("JCE invalid media playlist");
  const abs = resolver(base);
  let seq = 0, duration = null, stamp = null, target = null, prevEnd = null, prevStart = null, prevDur = null;
  const pinfo = { frac: false };
  const rows = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      target = parseInt(line.split(":")[1], 10) || 6;
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      if (!rows.length) {
        const s = parseInt(line.split(":")[1], 10);
        if (s >= 0) seq = s;
      }
    } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      stamp = parsePdt(line.slice(line.indexOf(":") + 1), pinfo);
    } else if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice(8).split(",")[0]);
      if (!Number.isFinite(duration) || !(duration > 0 && duration <= 60)) throw new Error("JCE invalid segment duration");
    } else if (line[0] !== "#") {
      if (duration === null) continue;
      if (stamp === null) stamp = prevEnd !== null ? prevEnd : nowSec - 60;
      if (prevStart !== null && pinfo.frac && stamp <= prevStart) throw new Error("JCE non-increasing PDT");
      if (prevStart !== null && !pinfo.frac && stamp < prevStart - 1.0) throw new Error("JCE non-increasing PDT");
      if (prevEnd !== null) {
        const gap = stamp - prevEnd;
        const overlapLimit = pinfo.frac
          ? Math.min(cfg.overlapMax, 0.25 * Math.min(prevDur, duration))
          : Math.max(cfg.overlapMax, 1.15);
        if (gap < -overlapLimit - 1e-7) stamp = prevEnd;
      }
      prevStart = stamp; prevDur = duration;
      const u = abs(line);
      if (!/^https?:\/\//i.test(u)) throw new Error("JCE invalid media URI");
      rows.push([seq + rows.length, stamp, duration, u, u.split("?")[0].split("/").pop()]);
      prevEnd = stamp + duration;
      stamp = prevEnd; duration = null;
    }
  }
  if (!rows.length) throw new Error("JCE incomplete media playlist");
  let maxSegDur = target || 6;
  for (const r of rows) maxSegDur = Math.max(maxSegDur, Math.ceil(r[2]));
  target = Math.min(60, Math.max(1, maxSegDur));

  let completed = rows.filter((r) => r[1] + r[2] <= nowSec + 1.5);
  if (completed.length < 3) completed = rows.slice();
  let cutAt = 0;
  for (let i = 1; i < completed.length; i++) if (completed[i][1] - (completed[i - 1][1] + completed[i - 1][2]) > 30) cutAt = i;
  completed = completed.slice(cutAt);
  const last = completed[completed.length - 1];
  if (completed.length < 3 || nowSec - (last[1] + last[2]) > 90) throw new Error("JCE no recent completed media");

  const holdLast = completed.length > 4 && (nowSec - (last[1] + last[2]) < 1.0);
  const picked = (holdLast ? completed.slice(0, -1) : completed).slice(-6);
  return { rows: picked, target, precise: pinfo.frac };
}

async function resolveAnchor(ch, st) {
  const rec = await sharedGet("anchor-" + ch.slug);
  if (rec && rec.url && rec.expiry > Date.now() + 10000) {
    st.anchor = { url: rec.url, expiry: rec.expiry, gen: rec.gen, offset: rec.offset, shared: true };
    return;
  }
  const nowS = Math.floor(Date.now() / 1000);
  const start = Math.floor((nowS - LIVE_BACK) / ANCHOR_BUCKET) * ANCHOR_BUCKET;
  const end = start + ANCHOR_BUCKET + LIVE_BACK + LIVE_AHEAD;
  const active = () => Date.now() / 1000 - st.lastAccess < LOW_IDLE;
  const url = await jaccUrl(ch, start, end, ch.defn, JACC_TIMEOUT, active);
  st.anchor = { url, expiry: (end - ANCHOR_MARGIN) * 1000, gen: `b-${start}`, offset: undefined, shared: false };
}

async function jceRefresh(ch, st) {
  if (Date.now() < st.mediaBlockedUntil) throw new RateLimited("JCE media 限流冷却中", (st.mediaBlockedUntil - Date.now()) / 1000);
  if (!st.anchor || Date.now() >= st.anchor.expiry) await resolveAnchor(ch, st);
  const anchor = st.anchor;

  let r;
  try {
    r = await fetch(anchor.url, {
      headers: H_JCE,
      cf: { cacheTtl: 0 },
      redirect: "follow",
      signal: AbortSignal.timeout(MEDIA_TIMEOUT),
    });
  } catch (e) {
    await invalidateAnchor(ch, st);
    throw e;
  }
  if (r.status === 429) {
    const delay = Math.max(THROTTLE_MIN, parseRetryAfter(r.headers.get("Retry-After")));
    st.mediaBlockedUntil = Date.now() + delay * 1000;
    throw new RateLimited(`JCE media 被上游限流 (HTTP 429${r.headers.get("Retry-After") ? " Retry-After=" + r.headers.get("Retry-After") : ""})`, delay);
  }
  if (!r.ok) {
    await invalidateAnchor(ch, st);
    throw new Error(`HTTP ${r.status} @${hostOf(anchor.url)}`);
  }
  const text = await r.text();
  if (text.length > 2097152) throw new Error("JCE playlist too large");

  let parsed;
  try {
    parsed = parseJceWindow(text, r.url || anchor.url, Date.now() / 1000);
  } catch (e) {
    await invalidateAnchor(ch, st);
    throw e;
  }
  const { rows: native, target, precise } = parsed;

  const tol = precise ? 0.05 : cfg.overlapMax;
  const same = (x, y) => (!!x[2] && x[2] === y[2]) || (Math.abs(x[0] - y[0]) <= tol && Math.abs(x[1] - y[1]) < 0.05);

  let offset = st.offset;
  if (st.accepted !== anchor.gen) {
    if (st.rows.size) {
      const offs = new Set();
      for (const [sq, stamp, dur, , key] of native) {
        for (const [oldSeq, v] of st.rows) if (same([stamp, dur, key], v)) offs.add(oldSeq - sq);
      }
      if (offs.size !== 1) throw new Reopen("JCE new window lacks unambiguous PDT overlap", true);
      offset = [...offs][0];
    } else offset = anchor.offset ?? 0;
  }
  const rows = native.map(([sq, t, d, u, k]) => [sq + offset, t, d, u, k]);
  const tail = rows[rows.length - 1];
  if (st.tail) {
    const [pSeq, pStamp, pKey, pDur] = st.tail;
    if (tail[0] < pSeq || tail[1] < pStamp - tol) throw new Reopen("JCE live window regressed", true);
    if ((tail[0] === pSeq) !== same([tail[1], tail[2], tail[4]], [pStamp, pDur, pKey])) throw new Reopen("JCE media sequence/PDT mismatch", true);
    for (const [sq, t, d, , k] of rows) {
      const o = st.rows.get(sq);
      if (o && !same([t, d, k], o)) throw new Reopen("JCE overlapping media changed", true);
    }
  }

  const overlapped = rows.some((x, i) => i > 0 && x[1] < rows[i - 1][1] + rows[i - 1][2] - 1e-6);
  const suppressPdt = st.suppressPdt || !precise || overlapped;
  const effTarget = Math.max(st.target || 0, target);
  const out = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${effTarget}`, `#EXT-X-MEDIA-SEQUENCE:${rows[0][0]}`];
  for (const [, t, d, u] of rows) {
    if (!suppressPdt) out.push("#EXT-X-PROGRAM-DATE-TIME:" + new Date(t * 1000).toISOString());
    out.push(`#EXTINF:${d.toFixed(6)},`, u);
  }
  const nowS = Date.now() / 1000;
  const prevTailKey = st.tail ? st.tail[2] : "";
  const advanced = tail[4] !== prevTailKey;

  st.suppressPdt = suppressPdt; st.target = effTarget; st.offset = offset; st.accepted = anchor.gen;
  st.tail = [tail[0], tail[1], tail[4], tail[2]]; st.precise = precise;
  st.rows = new Map(rows.map((x) => [x[0], [x[1], x[2], x[4]]]));
  st.playlist = out.join("\n") + "\n";
  st.mediaEnd = tail[1] + tail[2];
  st.builtAt = advanced || !prevTailKey ? nowS : Math.max(0, nowS - (REFRESH_AFTER - 0.6));
  st.lastOk = nowS; st.lastError = ""; st.lastErr = null;
  if (anchor.offset === undefined) anchor.offset = offset;
  if (!anchor.shared) {
    anchor.shared = true;
    await sharedPut("anchor-" + ch.slug, { url: anchor.url, expiry: anchor.expiry, gen: anchor.gen, offset: anchor.offset }, (anchor.expiry - Date.now()) / 1000 - 5);
  }
}

async function rawPlaylistReport(st) {
  const a = st.anchor;
  if (!a) return { error: "该频道还没有申请过 JCE 地址: 先用 LIVE_MODE=jce 请求一次该频道 (或加 &probe=1)" };
  const r = await fetch(a.url, {
    headers: H_JCE,
    cf: { cacheTtl: 0 },
    redirect: "follow",
    signal: AbortSignal.timeout(MEDIA_TIMEOUT),
  });
  const text = await r.text();
  const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const tags = {};
  for (const l of lines) if (l[0] === "#") { const k = l.split(":")[0]; tags[k] = (tags[k] || 0) + 1; }
  let stamp = null, dur = null, prevEnd = null, segments = 0, noPdt = 0;
  const gaps = [], durs = new Set();
  for (const l of lines) {
    if (l.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) { try { stamp = parsePdt(l.slice(l.indexOf(":") + 1)); } catch { stamp = null; } }
    else if (l.startsWith("#EXTINF:")) { dur = parseFloat(l.slice(8)); durs.add(dur); }
    else if (l[0] !== "#") {
      segments++;
      if (stamp === null || dur === null) noPdt++;
      else { if (prevEnd !== null) gaps.push(+(stamp - prevEnd).toFixed(3)); prevEnd = stamp + dur; stamp = prevEnd; }
      dur = null;
    }
  }
  const sorted = [...gaps].sort((x, y) => x - y);
  const cut = (l) => (l.length > 140 ? l.slice(0, 140) + `…(+${l.length - 140})` : l);
  return {
    status: r.status, bytes: text.length, host: hostOf(a.url), segments, segmentsWithoutPdt: noPdt, tags,
    durations: [...durs].slice(0, 8),
    gapSec: sorted.length ? { min: sorted[0], median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1], overlapsOver0_15: gaps.filter((g) => g < -0.15).length, overlapsOver0_5: gaps.filter((g) => g < -0.5).length, gapsOver1: gaps.filter((g) => g > 1).length } : null,
    lastGaps: gaps.slice(-20),
    head: lines.slice(0, 8).map(cut), tail: lines.slice(-4).map(cut),
  };
}

// ---- bk 通路 (v11.3 原生 m3u8 直通 + 60s 后台预刷 Token + 同域名优先锁定) ----
async function fetchBkPool(ch, st) {
  await bkSlot();
  const urls = await bkPlayUrls(ch.sid, ch.pid, ch.defn);
  // 若上一轮已有稳定播放的 CDN 域名 (lastHost), 将新池中同域名的新 Token 地址排在首位,
  // 既换上全新 Token 避免 120s 过期断流, 又保持在同一台 CDN 服务器上使 MEDIA-SEQUENCE 连续不跳变
  if (st.bk.lastHost) {
    urls.sort((a, b) => (hostOf(a) === st.bk.lastHost ? 0 : 1) - (hostOf(b) === st.bk.lastHost ? 0 : 1));
  }
  st.bk.urls = urls;
  st.bk.t = Date.now();
  await sharedPut("bk-" + ch.slug, { urls, t: st.bk.t, lastHost: st.bk.lastHost }, 65);
}

async function ensureBkUrls(ch, st, ctx, forceRefresh = false) {
  const age = Date.now() - st.bk.t;
  if (!forceRefresh && st.bk.urls.length && age <= BK_URL_TTL) {
    // 满 60 秒时在后台静默刷新地址池, 避免在 85 秒到期时阻塞播放器轮询
    if (age > BK_PREFETCH_MS && !st.bk.refreshing) {
      st.bk.refreshing = true;
      const bg = fetchBkPool(ch, st).catch(() => {}).finally(() => { st.bk.refreshing = false; });
      if (ctx && ctx.waitUntil) ctx.waitUntil(bg);
    }
    return;
  }
  if (!forceRefresh) {
    const shared = await sharedGet("bk-" + ch.slug);
    if (shared && Array.isArray(shared.urls) && shared.urls.length && Date.now() - shared.t <= BK_URL_TTL) {
      st.bk.urls = shared.urls;
      st.bk.t = shared.t;
      if (!st.bk.lastHost && shared.lastHost) st.bk.lastHost = shared.lastHost;
      return;
    }
  }
  await fetchBkPool(ch, st);
}

async function bkRefresh(ch, st, ctx) {
  await ensureBkUrls(ch, st, ctx, false);
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    // 若已有稳定域名, 优先尝试池中该域名的最新 Token 地址
    const candidates = [...st.bk.urls].slice(0, 4);
    if (st.bk.lastHost) {
      candidates.sort((a, b) => (hostOf(a) === st.bk.lastHost ? 0 : 1) - (hostOf(b) === st.bk.lastHost ? 0 : 1));
    }
    for (const u of candidates) {
      try {
        const { text, final } = await fetchMediaPlaylist(u, H_BK, 0, BK_TIMEOUT);
        if (!text.includes("#EXTM3U") || !text.includes("#EXTINF")) continue;
        const seqM = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
        const seq = seqM ? parseInt(seqM[1], 10) : -1;
        const h = hostOf(u);
        // 同域名下序号小幅倒退 (1~20) 说明命中了滞后的边缘节点, 保留现有列表不覆盖
        if (h === st.bk.lastHost && st.bk.lastSeq >= 0 && seq >= 0 && seq < st.bk.lastSeq && st.bk.lastSeq - seq <= 20 && st.playlist && Date.now() / 1000 - st.lastOk < 15) {
          return;
        }
        const nowS = Date.now() / 1000;
        const pl = absolutize(text, final);
        const segLines = pl.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
        const tailSeg = segLines.length ? segLines[segLines.length - 1].split("?")[0] : "";
        const advanced = tailSeg && tailSeg !== st.bk.lastTail;
        st.bk.lastTail = tailSeg;
        st.bk.lastHost = h;
        st.bk.lastSeq = seq;
        st.playlist = pl;
        st.builtAt = advanced || !st.builtAt ? nowS : Math.max(0, nowS - (REFRESH_AFTER - 0.6));
        st.lastOk = nowS; st.mediaEnd = 0; st.lastError = ""; st.lastErr = null;
        return;
      } catch (e) {
        last = errMsg(e);
        if (attempt === 0 && /HTTP (401|403|410)\b/.test(last)) break;
      }
    }
    if (attempt === 0) {
      try {
        await ensureBkUrls(ch, st, ctx, true);
      } catch (e) {
        last = errMsg(e);
        if (e && e.status === 429) bkGate.blockedUntil = Date.now() + Math.max(THROTTLE_MIN, parseRetryAfter(e.retryAfter)) * 1000;
        break;
      }
    }
  }
  st.bk = { urls: [], t: 0, lastTail: st.bk.lastTail, lastHost: st.bk.lastHost, lastSeq: st.bk.lastSeq, refreshing: false };
  await sharedDel("bk-" + ch.slug);
  throw new Error(last.slice(0, 120) || "bk playlist failed");
}

// ---- 刷新调度 / 对外服务 ----
async function runJceWithRetry(ch, st) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await jceRefresh(ch, st);
      return;
    } catch (e) {
      if (e instanceof Reopen && attempt === 0) {
        resetContinuity(st);
        continue;
      }
      if (e instanceof Reopen) resetContinuity(st);
      throw e;
    }
  }
}

async function refreshOnce(ch, st, ctx) {
  const mode = effectiveMode(ch, st);
  if (mode === "bk") {
    try {
      await bkRefresh(ch, st, ctx);
      return;
    } catch (bkErr) {
      // 仅在冷启动完全无列表 (!st.playlist) 时才尝试 JCE 兜底;
      // 正常播放中途绝不切往 JCE (播放中途切 JCE 会因序号体系不同直接导致播放器断连或卡死)
      if (cfg.mode === "auto" && !st.playlist && !FORCE_BK.has(ch.slug) && TIMESHIFT_SUPPORTED.has(ch.slug)) {
        st.mode = "jce";
        st.stickyUntil = Date.now() + STICKY_MS;
        resetContinuity(st);
        await runJceWithRetry(ch, st);
        return;
      }
      throw bkErr;
    }
  }

  // 当前在 jce 模式
  try {
    await runJceWithRetry(ch, st);
    return;
  } catch (jceErr) {
    if (!FORCE_JCE.has(ch.slug) && cfg.mode !== "jce") {
      st.mode = "bk";
      st.stickyUntil = Date.now() + STICKY_MS;
      resetContinuity(st);
      await bkRefresh(ch, st, ctx);
      return;
    }
    throw jceErr;
  }
}

function refreshLive(ch, st, ctx, background) {
  if (st.inflight && Date.now() - st.inflightAt < P_MAX) return st.inflight;
  if (background && Date.now() < st.retryAt) return Promise.resolve(false);
  const p = (async () => {
    try {
      await refreshOnce(ch, st, ctx);
      st.fails = 0; st.retryAt = 0;
      return true;
    } catch (e) {
      st.lastErr = e; st.lastError = errMsg(e).slice(0, 160); st.fails++;
      st.retryAt = Date.now() + (e instanceof RateLimited ? Math.min(15000, e.retry * 1000) : (st.fails < 3 ? 1500 : 5000));
      return false;
    } finally {
      if (st.inflight === p) st.inflight = null;
    }
  })();
  st.inflight = p; st.inflightAt = Date.now();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return p;
}

function playlistUsable(st, mode, nowS) {
  if (!st.playlist) return false;
  if (nowS - st.builtAt >= FRESH_MAX) return false;
  if (nowS - st.lastOk > LOW_PLAYLIST_MAX_AGE) return false;
  if (mode === "jce" && st.mediaEnd && nowS - st.mediaEnd > 90) return false;
  return true;
}

async function serveLive(ch, ctx, useProxy = false) {
  const st = liveState(ch);
  let mode = effectiveMode(ch, st);
  const nowS = Date.now() / 1000;
  if (mode === "jce" && nowS - st.lastAccess >= LOW_IDLE && !st.inflight) resetContinuity(st);
  st.lastAccess = nowS;

  const usable = () => playlistUsable(st, effectiveMode(ch, st), Date.now() / 1000);
  let cache = "HIT";
  const ageSec = Date.now() / 1000 - st.builtAt;

  if (usable() && ageSec <= REFRESH_AFTER) {
    cache = "HIT";
  } else if (usable()) {
    const prevBuiltAt = st.builtAt;
    await waitFor(refreshLive(ch, st, ctx, false), SYNC_WAIT_MS);
    cache = st.builtAt > prevBuiltAt ? "REFRESH" : "SWR";
  } else {
    cache = "MISS";
    await waitFor(refreshLive(ch, st, ctx, false), COLD_WAIT_MS);
  }

  mode = effectiveMode(ch, st);
  if (usable() || (st.playlist && Date.now() / 1000 - st.lastOk <= LOW_PLAYLIST_MAX_AGE)) {
    const body = useProxy ? rewritePlaylistProxy(st.playlist, mode) : st.playlist;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": M3U8,
        "Cache-Control": "no-cache, no-store, max-age=0",
        "X-Mode": mode,
        "X-Cache": cache,
        "X-Age": (Date.now() / 1000 - st.builtAt).toFixed(1),
        ...(st.bk.lastHost && mode === "bk" ? { "X-Host": st.bk.lastHost } : {}),
        ...(useProxy ? { "X-Proxy": "1" } : {}),
        ...CORS,
      },
    });
  }
  const limitedFor = Math.max(gateRemainingSec(), (st.mediaBlockedUntil - Date.now()) / 1000, mode === "bk" ? (bkGate.blockedUntil - Date.now()) / 1000 : 0);
  const limited = limitedFor > 0;
  const msg = limited
    ? `频道 ${ch.name}: 上游限流冷却中, 约 ${Math.ceil(limitedFor)} 秒后再试` + (gateRemainingSec() > 0 && gate.last ? ` [上游返回: ${gate.last.detail}; 触发于 ${gate.last.channel || "?"} ${gate.last.at}; 连续限流等级 ${gate.penalty}s]` : (st.lastError ? ` [${st.lastError}]` : ""))
    : `频道 ${ch.name} 暂无数据 (${st.inflight ? "拉取中" : (st.lastError || "无可用列表")}), 请稍后重试`;
  return reply(msg + "\n", 503, "text/plain; charset=utf-8", { "Retry-After": String(limited ? Math.ceil(limitedFor) : 2) });
}

// ---- 分片代理 (/seg?u=...) ----
const ALLOWED_SEG_HOST = /\.(cctv\.cn|cctv\.com|myalicdn\.com|rtx3090\.com|gitv\.tv|cntv\.cn)$/i;
async function handleSegProxy(request, sp) {
  const rawUrl = sp.get("u");
  if (!rawUrl) return reply("missing u\n", 400);
  let target;
  try { target = new URL(rawUrl); } catch { return reply("bad url\n", 400); }
  if (target.protocol !== "http:" && target.protocol !== "https:") return reply("bad scheme\n", 400);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(target.hostname);
  if (!isIp && !ALLOWED_SEG_HOST.test(target.hostname)) return reply("forbidden host\n", 403);

  const mode = sp.get("m") === "jce" ? "jce" : "bk";
  const reqHeaders = new Headers(mode === "bk" ? H_BK : H_JCE);
  const range = request.headers.get("Range") || request.headers.get("range");
  if (range) reqHeaders.set("Range", range);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(target.toString(), {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: reqHeaders,
        redirect: "follow",
        cf: { cacheTtl: 60, cacheEverything: true },
        signal: AbortSignal.timeout(15000),
      });
      if (r.status >= 500 && attempt === 0) continue;
      const resHeaders = new Headers(CORS);
      resHeaders.set("Content-Type", r.headers.get("Content-Type") || "video/mp2t");
      resHeaders.set("Cache-Control", "public, max-age=60");
      for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
        const v = r.headers.get(h);
        if (v) resHeaders.set(h, v);
      }
      return new Response(r.body, { status: r.status, headers: resHeaders });
    } catch (e) {
      if (attempt === 1) return reply(`segment proxy error: ${errMsg(e)}\n`, 502);
    }
  }
}

// ---- 回看 ----
const sumExtinf = (text) => { let t = 0; for (const m of text.matchAll(/#EXTINF:\s*([\d.]+)/g)) t += parseFloat(m[1]) || 0; return t; };
const countSegs = (text) => (text.match(/#EXTINF:/g) || []).length;
const transient = (e) => !!(e && (e.dead || e.name === "TimeoutError" || /HTTP 5\d\d|fetch failed|network/i.test(errMsg(e))));

async function jceRangeText(ch, start, end, defn) {
  const u = await jaccUrl(ch, start, end, defn, CU_JACC_TIMEOUT);
  const { text, final } = await fetchPlaylistAny(u, [H_JCE, H_BK], CU_FETCH_TIMEOUT);
  if (!text.includes("#EXTINF")) throw new Error("empty playlist");
  return { text, final };
}

async function catchupWhole(ch, start, end) {
  const t0 = Date.now();
  const defns = [...new Set([ch.defn, "fhd", "shd"])];
  let last = null;
  for (const defn of defns) {
    for (let k = 0; k < 2; k++) {
      if (last && Date.now() - t0 > CU_BUDGET) throw last;
      try {
        const r = await jceRangeText(ch, start, end, defn);
        return { ...r, defn, dur: sumExtinf(r.text) };
      } catch (e) { last = e; if (e instanceof RateLimited) throw e; if (!transient(e)) break; }
    }
  }
  throw last;
}

async function catchupChunked(ch, start, end, defn) {
  const ranges = [];
  for (let t = start; t < end; t += CU_CHUNK) ranges.push([t, Math.min(t + CU_CHUNK, end)]);
  const one = async (r) => {
    const { text, final } = await jceRangeText(ch, r[0], r[1], defn);
    const segs = parseMedia(text, final);
    if (!segs.length) throw new Error("empty playlist");
    return { segs };
  };
  const res = new Array(ranges.length);
  res[0] = await one(ranges[0]);
  let next = 1;
  const run = async () => {
    while (next < ranges.length) {
      const i = next++;
      try { res[i] = await one(ranges[i]); } catch (e) { res[i] = { error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CU_PARALLEL, Math.max(0, ranges.length - 1)) }, run));

  const segs = [];
  const seen = new Set();
  let gap = false, gaps = 0;
  for (const r of res) {
    if (!r || r.error) { if (segs.length) { gap = true; gaps++; } continue; }
    for (const sg of r.segs) {
      const clean = sg.url.split("?")[0];
      const k = clean.split("/").slice(-2).join("/");
      if (seen.has(k)) continue;
      seen.add(k);
      segs.push(gap ? { ...sg, disc: true } : sg);
      gap = false;
    }
  }
  if (!segs.length) throw new Error("empty playlist");
  return { segs, gaps, chunks: ranges.length };
}

async function catchupPlaylist(ch, start, end) {
  const want = end - start;
  let whole = null, err = null;
  try { whole = await catchupWhole(ch, start, end); } catch (e) { err = e; if (e instanceof RateLimited) throw e; }
  if (whole && whole.dur >= want * 0.9) {
    return { pl: absolutize(whole.text, whole.final, true), mode: "whole", segs: countSegs(whole.text), dur: whole.dur };
  }
  if (want > CU_CHUNK) {
    try {
      const c = await catchupChunked(ch, start, end, whole?.defn || ch.defn);
      const cd = sumDur(c.segs);
      if (!whole || cd > whole.dur) return { pl: renderVod(c.segs), mode: "chunked", segs: c.segs.length, dur: cd, gaps: c.gaps };
    } catch (e) { err ??= e; }
  }
  if (whole) return { pl: absolutize(whole.text, whole.final, true), mode: "whole-partial", segs: countSegs(whole.text), dur: whole.dur };
  throw err || new Error("catchup failed");
}

function cachedCatchup(ch, cu, ctx) {
  const key = `${ch.slug}|${cu.start}|${cu.end}`;
  const hit = cuCache.get(key);
  if (hit && Date.now() - hit.t < CU_CACHE_TTL && (hit.done || Date.now() - hit.t < CU_PEND_MAX)) return hit.p;
  const p = catchupPlaylist(ch, cu.start, cu.end);
  if (!cu.open) {
    const ent = { t: Date.now(), p, done: false };
    cuCache.set(key, ent);
    p.then(() => { ent.done = true; }, () => { if (cuCache.get(key) === ent) cuCache.delete(key); });
    if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {}));
    if (cuCache.size > 40) cuCache.delete(cuCache.keys().next().value);
  }
  return p;
}

// ---- /all.m3u ----
function allM3u(origin, sp, tokenQs) {
  const group = sp.get("group");
  const only4k = ["1", "true", "yes"].includes((sp.get("k4") || "0").toLowerCase());
  const useProxy = cfg.proxyTs || ["1", "true", "yes"].includes((sp.get("proxy") || "0").toLowerCase());
  const mode = (sp.get("mode") || "").toLowerCase();
  const tzQ = (sp.get("tz") || "").trim();
  const proxyPart = useProxy ? (tokenQs ? "&proxy=1" : "?proxy=1") : "";
  const baseQs = tokenQs + proxyPart;
  const sep = baseQs ? "&" : "?";
  const fmt = "${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}";
  const tzPart = tzQ ? "&tz=" + encodeURIComponent(tzQ) : "";
  const epgUrl = `${origin}/epg.xml${tokenQs}`;
  const lines = [
    `#EXTM3U url-tvg="${epgUrl}" x-tvg-url="${epgUrl}"`,
    "#EXT-X-APTV-PREVIEW: FALSE",
    "#EXT-X-APTV-LATENCY: FALSE",
    "#EXT-X-APTV-LOGO: FALSE",
  ];
  for (const c of CHANNELS) {
    const grp = groupOf(c.slug);
    if (group && !grp.includes(group)) continue;
    if (only4k && !TRUE_4K.has(c.slug)) continue;
    const chUrl = `${origin}/${c.slug}.m3u8${baseQs}`;
    let attrs = ` tvg-id="${TVG_IDS[c.slug] || c.slug.toUpperCase()}" tvg-name="${c.name}" tvg-logo="${LOGO_BASE}/${c.slug}.png" group-title="${grp}"`;
    if (TIMESHIFT_SUPPORTED.has(c.slug)) {
      attrs += mode === "utc"
        ? ' catchup="default" catchup-days="7" catchup-source="' + chUrl + sep + "utc={utc}&lutc={lutc}" + '"'
        : ' catchup="append" catchup-days="7" catchup-source="' + sep + "playseek=" + fmt + tzPart + '"';
    }
    lines.push(`#EXTINF:-1${attrs},${c.name}`, chUrl);
  }
  return lines.join("\n") + "\n";
}

// ---- EPG: 多源回退 + 流式转换 + Cache API 缓存 ----
const EPG_SOURCES = [
  "https://epg.zsdc.eu.org/t.xml.gz",
  "https://epg.pw/xmltv/epg_CN.xml.gz",
  "https://live.fanmingming.com/e.xml",
  "http://epg.51zmt.top:8000/e.xml.gz",
];
const EPG_TTL = 3600;

async function sniffBody(body) {
  const reader = body.getReader();
  const first = await reader.read();
  const head = first.value || new Uint8Array(0);
  const stream = new ReadableStream({
    start(c) { if (head.length) c.enqueue(head); if (first.done) c.close(); },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close(); else c.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { head, stream, gz: head.length > 1 && head[0] === 31 && head[1] === 139 };
}

async function handleEpg(request, ctx, wantGz) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL(wantGz ? "/epg.xml.gz" : "/epg.xml", request.url).toString());
  if (cache) { try { const hit = await cache.match(key); if (hit) return hit; } catch {} }

  let lastErr = "";
  for (const u of EPG_SOURCES) {
    try {
      const r = await fetch(u, { headers: H_JCE, cf: { cacheTtl: EPG_TTL, cacheEverything: true }, signal: AbortSignal.timeout(15000) });
      if (!r.ok || !r.body) { lastErr = `${u} -> HTTP ${r.status}`; continue; }
      const { head, stream, gz } = await sniffBody(r.body);
      if (!gz && !/<\?xml|<tv[\s>]/i.test(td.decode(head.subarray(0, 256)))) {
        lastErr = `${u} -> not xml/gzip`;
        stream.cancel().catch(() => {});
        continue;
      }
      let body, type;
      if (wantGz) { body = gz ? stream : stream.pipeThrough(new CompressionStream("gzip")); type = "application/gzip"; }
      else { body = gz ? stream.pipeThrough(new DecompressionStream("gzip")) : stream; type = "application/xml; charset=utf-8"; }
      const resp = new Response(body, { status: 200, headers: { "Content-Type": type, "Cache-Control": `public, max-age=${EPG_TTL}`, ...CORS } });
      if (cache && ctx) ctx.waitUntil(cache.put(key, resp.clone()).catch(() => {}));
      return resp;
    } catch (e) { lastErr = `${u} -> ${errMsg(e)}`; }
  }
  return reply(`EPG 获取失败 (${lastErr})\n`, 502);
}

// ---- 诊断: /<channel>.m3u8?debug=1 ----
async function probeSeg(u) {
  const t = Date.now();
  try {
    const r = await fetch(u, { headers: { ...H_JCE, Range: "bytes=0-1023" }, signal: AbortSignal.timeout(5000) });
    const rd = r.body.getReader();
    const { value } = await rd.read();
    rd.cancel().catch(() => {});
    return { status: r.status, ms: Date.now() - t, type: r.headers.get("content-type"), len: r.headers.get("content-length"), firstByte: value && value.length ? (value[0] === 0x47 ? "0x47(TS)" : "0x" + value[0].toString(16)) : null };
  } catch (e) { return { error: errMsg(e), ms: Date.now() - t }; }
}
async function debugChannel(ch, cu, sp, ctx) {
  const st = liveState(ch);
  const age = (t) => (t ? +(Date.now() / 1000 - t).toFixed(1) : null);
  const out = {
    channel: ch.slug, version: VERSION, mode: cfg.mode, effectiveMode: effectiveMode(ch, st), guid: GUID.slice(0, 6) + "…", forceBk: FORCE_BK.has(ch.slug),
    gate: { blockedForSec: Math.round(gateRemainingSec()), penalty: gate.penalty, lastThrottle: gate.last, nextSlotInMs: Math.max(0, Math.round(gate.next - Date.now())) },
    sharedCache: await sharedProbe(),
    live: {
      bkLastHost: st.bk.lastHost || null,
      bkPoolSize: st.bk.urls.length,
      bkPoolAgeSec: st.bk.t ? Math.round((Date.now() - st.bk.t) / 1000) : null,
      anchor: st.anchor && { host: hostOf(st.anchor.url), expiresInSec: Math.round((st.anchor.expiry - Date.now()) / 1000), gen: st.anchor.gen, sharedOffset: st.anchor.offset ?? null },
      accepted: !!st.anchor && st.accepted === st.anchor.gen, offset: st.offset, tailSeq: st.tail ? st.tail[0] : null, target: st.target, pdtPrecise: st.precise, suppressPdt: st.suppressPdt,
      playlistAgeSec: age(st.builtAt), mediaEndAgeSec: st.mediaEnd ? age(st.mediaEnd) : null, lastOkAgeSec: age(st.lastOk),
      lastError: st.lastError || null, fails: st.fails, retryInSec: Math.max(0, Math.round((st.retryAt - Date.now()) / 1000)),
      mediaBlockedForSec: Math.max(0, Math.round((st.mediaBlockedUntil - Date.now()) / 1000)), inflight: !!st.inflight,
    },
  };
  if (sp.get("probe") === "1") {
    st.lastAccess = Date.now() / 1000;
    const t0 = Date.now();
    const ok = await refreshLive(ch, st, ctx, false);
    const urls = (st.playlist.match(/^https?:\/\/.*$/gm) || []);
    out.probe = { ok, ms: Date.now() - t0, error: ok ? null : st.lastError, segments: urls.length, head: st.playlist.split(/\r?\n/).slice(0, 6) };
    if (urls.length) out.probe.segFirst = await probeSeg(urls[0]), out.probe.segLast = await probeSeg(urls[urls.length - 1]);
  }
  if (sp.get("raw") === "1") {
    try { out.raw = await rawPlaylistReport(st); } catch (e) { out.raw = { error: errMsg(e) }; }
  }
  if (sp.get("bk") === "1") {
    const t1 = Date.now();
    try {
      await bkSlot();
      const urls = await bkPlayUrls(ch.sid, ch.pid, ch.defn);
      const { text, final } = await fetchMediaPlaylist(urls[0], H_BK, 0, BK_TIMEOUT);
      const segs = parseMedia(text, final);
      out.bk = { ok: true, ms: Date.now() - t1, urls: urls.map(stripQ), segments: segs.length, firstSeg: segs[0] && stripQ(segs[0].url), head: text.split(/\r?\n/).slice(0, 8) };
    } catch (e) { out.bk = { ok: false, ms: Date.now() - t1, error: errMsg(e) }; }
  }
  const own = !!(cu && !cu.bad);
  if (own || sp.get("catchup") === "1") {
    const now2 = Math.floor(Date.now() / 1e3);
    const rq = own ? cu : { start: now2 - 2400, end: now2 - 600 };
    const t2 = Date.now();
    const cd = { selfTest: !own, supported: TIMESHIFT_SUPPORTED.has(ch.slug), tz: cfg.tz, start: rq.start, end: rq.end, startBJ: fmtBJ(rq.start), endBJ: fmtBJ(rq.end), spanSec: rq.end - rq.start };
    if (cu && cu.bad) cd.paramError = cu.bad;
    out.catchup = cd;
    try {
      const u = await jaccUrl(ch, rq.start, rq.end, ch.defn, CU_JACC_TIMEOUT);
      cd.jaccMs = Date.now() - t2;
      cd.m3u8 = stripQ(u);
      const { text, final } = await fetchPlaylistAny(u, [H_JCE, H_BK], CU_FETCH_TIMEOUT);
      const segs = parseMedia(text, final);
      const dur = sumDur(segs);
      Object.assign(cd, {
        ok: segs.length > 0, ms: Date.now() - t2, host: hostOf(final), segments: segs.length,
        coverageSec: Math.round(dur), coverage: rq.end > rq.start ? +(dur / (rq.end - rq.start)).toFixed(2) : null,
        hasEndlist: text.includes("#EXT-X-ENDLIST"), hasDiscontinuity: segs.some((s) => s.disc),
        firstSeg: segs[0] && stripQ(segs[0].url), lastSeg: segs.length ? stripQ(segs[segs.length - 1].url) : null,
        head: text.split(/\r?\n/).slice(0, 8),
      });
      cd.scheme = segs[0] ? segs[0].url.split(":")[0] : null;
      cd.tail = text.split(/\r?\n/).filter(Boolean).slice(-3).map((l) => (l[0] === "#" ? l : stripQ(l).slice(-60)));
      if (!segs.length) cd.error = "empty playlist";
      else {
        cd.probe = { first: await probeSeg(segs[0].url), last: await probeSeg(segs[segs.length - 1].url) };
        const bad = [cd.probe.first, cd.probe.last].some((p) => p.error || p.status >= 400);
        if (bad) cd.hint = "播放列表拿到了, 但分片本身取不到: 可尝试加 ?proxy=1 走 Worker 代理分片";
        else if (cd.coverage !== null && cd.coverage < 0.9) cd.hint = "上游只返回了部分时长, 实际回看会自动走分段拼接兜底";
        else if (cd.scheme === "http") cd.hint = "分片是明文 http://: 若浏览器或 HTTPS 播放器拦截, 可加 ?proxy=1 或设环境变量 PROXY_TS=1";
      }
    } catch (e) {
      cd.ok = false;
      cd.ms = Date.now() - t2;
      cd.error = errMsg(e);
      if (e.dead) cd.hint = `JACC 返回了已失效的 CDN 域名 (${e.host}), 回看会自动重试/换清晰度; 若始终如此则是上游限制`;
      else if (/errCode|ret|code/i.test(cd.error)) cd.hint = "JACC 明确拒绝了该请求: 常见原因是超出回看保留期、节目时间段无录像, 或出口 IP/地区受限";
      else if (e.name === "TimeoutError") cd.hint = "请求 JACC/CDN 超时: 可能是出口节点到上游网络质量差";
    }
  }
  return reply(JSON.stringify(out, null, 2), 200, "application/json; charset=utf-8");
}

// ---- 入口 ----
export default {
  async fetch(request, env, ctx) {
    env = env || {};
    opts.nativeGzip = env.NATIVE_GZIP === "1";
    cfg.mode = env.LIVE_MODE === "jce" || env.LIVE_MODE === "bk" ? env.LIVE_MODE : "auto";
    cfg.proxyTs = env.PROXY_TS === "1";
    cfg.token = env.TOKEN || "";
    const ipTz = request.cf?.timezone || null;
    const envTz = String(env.CATCHUP_TZ || "").trim();
    const tzDefault = envTz.toLowerCase() === "auto" ? parseTz(ipTz, 480) : parseTz(envTz, 480);
    cfg.tz = tzDefault;
    const po = Number(env.PDT_OVERLAP_MAX);
    cfg.overlapMax = Number.isFinite(po) && po >= 0.05 && po <= 3 ? po : 1.2;
    const mx = Number(env.CATCHUP_MAX);
    cfg.max = mx >= 600 && mx <= 43200 ? mx : 14400;
    initGuid(env.GUID);

    const url = new URL(request.url);
    cfg.origin = url.origin;
    const { pathname: path } = url;
    const sp = new URLSearchParams(url.search.replace(/\?/g, (m, i) => (i === 0 ? m : "&")));
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    if (request.method !== "GET" && request.method !== "HEAD") return reply("method not allowed\n", 405);
    const authed = !env.TOKEN || sp.get("token") === env.TOKEN;
    if (!authed && path !== "/" && path !== "/favicon.ico") return reply("unauthorized\n", 401);
    const tokenQs = env.TOKEN ? `?token=${encodeURIComponent(env.TOKEN)}` : "";

    if (path === "/" || path === "/index.html") {
      const qs = authed ? tokenQs : "?token=你的TOKEN";
      const sp2 = qs ? "&" : "?";
      return reply(
        `ysp-live IPTV 直播网关 (Cloudflare Worker ${VERSION})\n\n` +
        `1. 通用订阅 (TVBox / 影视仓 / APTV 等):\n   ${url.origin}/all.m3u${qs}\n\n` +
        `2. 分片代理订阅 (推荐在直连 CDN 偶发黑屏/断连时使用):\n   ${url.origin}/all.m3u${qs}${sp2}proxy=1\n\n` +
        `3. ynoTV (Windows) / TiviMate / Kodi 订阅:\n   ${url.origin}/all.m3u${qs}${sp2}mode=utc\n\n` +
        `4. EPG 节目单:\n   ${url.origin}/epg.xml${qs}\n   ${url.origin}/epg.xml.gz${qs}\n\n` +
        `5. 仅 4K/8K 频道:\n   ${url.origin}/all.m3u${qs}${sp2}k4=1\n\n` +
        `6. 排障:\n   ${url.origin}/health${qs}\n   ${url.origin}/last${qs}\n   ${url.origin}/cctv1.m3u8${qs}${sp2}debug=1&probe=1\n` +
        (authed || !env.TOKEN ? "" : "\n(已设置 TOKEN: 请把上面的 \"你的TOKEN\" 换成真实口令)\n")
      );
    }
    if (path === "/favicon.ico") return reply('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📺</text></svg>', 200, "image/svg+xml");
    if (path === "/seg") return handleSegProxy(request, sp);
    if (path === "/health") {
      return reply(JSON.stringify({
        ok: true, version: VERSION, mode: cfg.mode, proxyTs: cfg.proxyTs, channels: CHANNELS.length, catchupTz: cfg.tz, catchupMax: cfg.max,
        gate: { blockedForSec: Math.round(gateRemainingSec()), penalty: gate.penalty, lastThrottle: gate.last },
        sharedCache: await sharedProbe(), liveChannelsInMemory: LIVE.size,
        ipTz, colo: request.cf?.colo || null,
        routes: ["/all.m3u", "/all.m3u?proxy=1", "/all.m3u?mode=utc", "/epg.xml", "/epg.xml.gz", "/health", "/last", "/<channel>.m3u8", "/seg"],
      }, null, 2), 200, "application/json; charset=utf-8");
    }
    if (path === "/last") {
      return reply(JSON.stringify({
        version: VERSION, catchupTz: cfg.tz, ipTz, liveHits,
        withParams: [...reqLog].reverse(),
        recentLive: [...liveLog].reverse(),
        tip: "记录在 isolate 内存里, 多实例时可能不全; 也可在 Cloudflare 控制台 Workers > Logs 的实时日志里看 [req] 行",
      }, null, 2), 200, "application/json; charset=utf-8");
    }
    if (path === "/all.m3u") return reply(allM3u(url.origin, sp, tokenQs), 200, M3U8);
    if (path === "/epg.xml" || path === "/epg.xml.gz") return handleEpg(request, ctx, path.endsWith(".gz"));

    const m = path.match(/^\/(?:live\/)?([\w-]+)\.m3u8$/);
    if (!m) return reply("not found\n", 404);
    const slug = normalize(m[1]);
    const ch = CH.get(slug);
    if (!ch) return reply("未知频道\n", 404);

    const cu = parseCatchup(sp, tzDefault, cfg.max, ipTz);
    if (sp.has("debug")) return debugChannel(ch, cu, sp, ctx);

    const useProxy = cfg.proxyTs || ["1", "true", "yes"].includes((sp.get("proxy") || "0").toLowerCase());
    const t0 = Date.now();
    const hasParams = [...sp.keys()].some((k) => k !== "token" && k !== "proxy");
    const note = (res, extra = {}) => {
      const e = { at: new Date().toISOString(), path, q: maskQ(url.search), status: res.status, ms: Date.now() - t0, ua: (request.headers.get("user-agent") || "").slice(0, 90), ipTz, ...extra };
      if (hasParams) { pushLog(reqLog, e, 30); console.log("[req]", JSON.stringify(e)); }
      else {
        liveHits++;
        if (Date.now() - (liveSeen.get(slug) || 0) > 20000) { liveSeen.set(slug, Date.now()); pushLog(liveLog, e, 10); }
      }
      return res;
    };
    const asked = cu && !cu.bad ? { interpretedAs: { startBJ: fmtBJ(cu.start), endBJ: fmtBJ(cu.end), tz: cu.tz } } : {};

    // 回看
    if (cu) {
      if (cu.bad) return note(reply(cu.bad + "\n", 400), { bad: cu.bad });
      if (!TIMESHIFT_SUPPORTED.has(slug)) return note(reply(`${ch.name} 不支持回看\n`, 400));
      try {
        const r = await cachedCatchup(ch, cu, ctx);
        const body = useProxy ? rewritePlaylistProxy(r.pl, "jce") : r.pl;
        return note(new Response(body, {
          status: 200,
          headers: {
            "Content-Type": M3U8,
            "Cache-Control": "no-cache",
            "X-Catchup": `${cu.start}-${cu.end}`,
            "X-Catchup-Mode": r.mode,
            "X-Catchup-Segs": String(r.segs),
            "X-Catchup-Dur": String(Math.round(r.dur)),
            ...(r.gaps ? { "X-Catchup-Gaps": String(r.gaps) } : {}),
            ...(useProxy ? { "X-Proxy": "1" } : {}),
            ...CORS,
          },
        }), { ...asked, mode: r.mode, segs: r.segs });
      } catch (e) {
        if (e instanceof RateLimited) return note(reply(`回看暂不可用: 上游限流冷却中, 约 ${e.retry} 秒后再试\n`, 503, "text/plain; charset=utf-8", { "Retry-After": String(e.retry) }), { ...asked, error: errMsg(e).slice(0, 160) });
        return note(reply(`回看失败 ${ch.name} ${fmtBJ(cu.start)} ~ ${fmtBJ(cu.end)} (${errMsg(e)})\n可访问 ${url.origin}/${slug}.m3u8${tokenQs ? tokenQs + "&" : "?"}debug=1 查看诊断\n`, 502), { ...asked, error: errMsg(e).slice(0, 160) });
      }
    }

    // 直播
    const res = await serveLive(ch, ctx, useProxy);
    return note(res, { mode: res.headers.get("X-Mode") || undefined, cache: res.headers.get("X-Cache") || undefined });
  },
};
