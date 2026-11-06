// ============================================================
// ysp-live IPTV 直播网关 (Cloudflare Worker, 单文件)  v10.5.1 通用优化版
// ============================================================
// 环境变量 (均可选):
//   TOKEN        访问口令, 设置后所有路径(除 / 和 favicon)都需 ?token=xxx
//   LIVE_MODE    auto(默认) | jce | bk
//                auto: 先 JCE 时移合成直播, 失败后自动切 bk 并"粘住" 10 分钟, 避免来回切换导致卡顿
//   NATIVE_GZIP  设为 1 时 JCE 请求使用 CompressionStream 压缩 (默认用 stored-gzip)
//   GUID         32 位 hex, 固定设备 ID (不设则每个 isolate 随机生成)
//   CATCHUP_TZ   回看时间字符串(yyyyMMddHHmmss)所用时区, 默认 +08:00
//                可填 +08:00 / utc / IANA 名(如 Asia/Shanghai) / auto(取访问者 IP 时区)
//                只影响 playseek=yyyyMMddHHmmss 这类"本地时间"格式; utc={utc} 这类时间戳不受影响
//   CATCHUP_MAX  单次回看最长跨度(秒), 默认 14400 (4 小时), 范围 600~43200
//
// 订阅:
//   /all.m3u                 通用 (回看用 playseek=本地时间, 适合 TVBox/影视仓/APTV 等)
//   /all.m3u?mode=utc        回看用 utc={utc}&lutc={lutc} (ynoTV / Kodi / TiviMate)
//   /all.m3u?tz=-08:00       playseek 模式下声明播放器格式化时间用的时区
//   /epg.xml  /epg.xml.gz    节目单 (多源回退, 流式转换, 缓存 1 小时)
// 排障:
//   /last                    最近的回看/带参数请求 (token 已打码) 及网关解析出的时间
//   /cctv1.m3u8?debug=1      直播两条通路 + 回看自检 (含分片可达性)
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

// Workers 不允许在全局作用域生成随机数, 所以在首个请求里惰性初始化。
let GUID = "";
let MID = null;
let REQ_SEQ = 0;              // 并发请求 reqid 去重 (分段回看会同时发多个 JACC 请求)
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

// 向 JACC 申请时移 m3u8 地址 (直播合成 / 回看 都用它)
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
  if (!resp.ok) throw new Error("jacc HTTP " + resp.status);
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
    headers: { "User-Agent": "qqlive", Accept: "application/json" },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error("bkliveinfo HTTP " + r.status);
  const p = await r.json();
  if (Number(p.iretcode ?? -1) !== 0) throw new Error(`iretcode=${p.iretcode} ${p.errinfo || ""}`);
  let urls = [];
  if (p.playurl) urls.push(p.playurl);
  const bu = p.backurl_list || p.backurlList || p.backurl;
  if (Array.isArray(bu)) for (const it of bu) urls.push(typeof it === "string" ? it : it.url || it.playurl || "");
  else if (typeof bu === "string") urls.push(...bu.split(/[;,]/).filter((x) => x.trim()));
  urls = [...new Set(urls)].filter((u) => u && u.includes(".cctv."));
  if (!urls.length) throw new Error("no playurl");
  urls.sort((a, b) => (a.includes("bklive-") ? 0 : 1) - (b.includes("bklive-") ? 0 : 1) || (a < b ? -1 : a > b ? 1 : 0));
  return urls;
}

// ---------------- 网关主体 ----------------
const VERSION = "10.5.1-universal";
const UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const H_JCE = { "User-Agent": UA_BROWSER, Accept: "*/*" };
const H_BK = { "User-Agent": "qqlive", Referer: "https://live.cctv.cn/", Accept: "application/vnd.apple.mpegurl,application/json,*/*" };
const LOGO_BASE = "https://garysclub.sharewithyou.dpdns.org/logos/ysp-live-logos";

const JCE_WINDOW = 90;        // 向 JACC 申请的时移窗口(秒)
const KEEP_SEGS = 10;         // 直播列表保留的片段数
const PLAYLIST_TTL = 2000;    // 同频道播放列表缓存(ms)
const STALE_TTL = 30000;      // 上游故障时, 允许回放旧列表的最长时间(ms)
const BK_URL_TTL = 90000;     // bkliveinfo 播放地址缓存(ms); 带鉴权, 不宜太久
const STICKY_MS = 600000;     // JCE 失败转 bk 后, 多久内不再回切(ms)
const FETCH_TIMEOUT = 6000;   // 直播: 单次上游请求超时(ms)

// ---- 回看专用参数 ----
const CU_JACC_TIMEOUT = 8000;   // 回看: 向 JACC 申请地址的超时(ms)
const CU_FETCH_TIMEOUT = 12000; // 回看: 拉取(可能上千片段的)长列表的超时(ms)
const CU_CHUNK = 3600;          // 整段申请失败/被截断时, 分段申请的每段秒数 (1 小时, 减少拼接交界与子请求数)
const CU_PARALLEL = 3;          // 分段并发数 (注意免费版单请求子请求上限 50)
const CU_CACHE_TTL = 300000;    // 已播完节目的回看列表缓存(ms)
const CU_BUDGET = 16000;        // 单次回看"换清晰度/重试"的总预算(ms)

const CH = new Map(CHANNELS.map((c) => [c.slug, c]));
const cfg = { mode: "auto", tz: 480, max: 14400 }; // 默认最长回看跨度提升至 14400 秒 (4 小时)
const memo = new Map();       // slug -> { t, pl, mode, note, p }
const bkUrls = new Map();     // slug -> { t, urls }
const segState = new Map();   // slug -> Map(segKey -> seq)   (仅最后兜底用)
const sticky = new Map();     // slug -> 截止时间戳
const cuCache = new Map();    // "slug|start|end" -> { t, p }
const reqLog = [];            // 最近的回看/带参数请求 (isolate 内存, 仅供诊断)
const liveLog = [];           // 最近的纯直播请求 (每频道 20s 内只记一次)
const liveSeen = new Map();
let liveHits = 0;
const maskQ = (q) => q.replace(/([?&]token=)[^&?]*/gi, "$1***");
const pushLog = (list, e, max) => { list.push(e); if (list.length > max) list.shift(); };

const CORS = { "Access-Control-Allow-Origin": "*" };
const M3U8 = "application/vnd.apple.mpegurl";
const reply = (body, status = 200, type = "text/plain; charset=utf-8", extra = {}) =>
  new Response(body, { status, headers: { "Content-Type": type, "Cache-Control": "no-cache, no-store, max-age=0", ...CORS, ...extra } });
const errMsg = (e) => String((e && e.message) || e);

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
async function fetchText(url, headers, timeout = FETCH_TIMEOUT) {
  const r = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeout) });
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

async function fetchMediaPlaylist(url, headers, depth = 0, timeout = FETCH_TIMEOUT) {
  const { text, final } = await fetchText(url, headers, timeout);
  if (!text.includes("#EXTM3U")) throw new Error("not an m3u8 @" + (() => { try { return new URL(final).host; } catch { return "?"; } })());
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

// ---- JCE 时移 -> 合成直播列表 ----
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

const nominalDur = (win) => {
  const d = win.map((s) => s.dur).filter((x) => x > 0).sort((a, b) => a - b);
  return Math.max(1, Math.round(d.length ? d[d.length >> 1] : 6));
};

function localSeq(slug, win, nom) {
  const k = (s) => s.url.split("?")[0];
  const table = segState.get(slug) || new Map();
  let seq = null;
  for (let i = 0; i < win.length; i++) {
    const old = table.get(k(win[i]));
    if (old !== undefined) { seq = old - i; break; }
  }
  if (seq === null) {
    const base = Math.floor(Date.now() / 1e3 / nom);
    seq = table.size ? Math.max(base, Math.max(...table.values()) + 1) : base;
  }
  const next = new Map();
  win.forEach((s, i) => next.set(k(s), seq + i));
  segState.set(slug, next);
  return seq;
}

function stableSeq(slug, win) {
  const nom = nominalDur(win);
  const nums = win.slice(0, 2).map((s) => Number((s.url.split("?")[0].match(/(\d{3,})\.[a-z0-9]+$/i) || [])[1]));
  const step = nums.length === 2 ? nums[1] - nums[0] : NaN;
  if (step === 1) return nums[0];
  const t = win[0].pdt ? Date.parse(win[0].pdt) : NaN;
  if (!Number.isNaN(t)) return Math.round(t / 1e3 / nom);
  if (step > 1) return Math.round(nums[0] / step);
  return localSeq(slug, win, nom);
}

function renderLive(win, seq) {
  const target = Math.max(1, ...win.map((s) => Math.round(s.dur)));
  const out = ["#EXTM3U", `#EXT-X-VERSION:${win.some((s) => s.map) ? 6 : 3}`, `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${seq}`];
  let key = "", map = "";
  for (const s of win) {
    if (s.map && s.map !== map) { out.push(s.map); map = s.map; }
    if (s.key && s.key !== key) { out.push(s.key); key = s.key; }
    if (s.pdt) out.push("#EXT-X-PROGRAM-DATE-TIME:" + s.pdt);
    out.push(`#EXTINF:${s.dur.toFixed(3)},`, s.url);
  }
  return out.join("\n") + "\n";
}

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

function buildLive(slug, text, baseUrl) {
  const segs = parseMedia(text, baseUrl);
  if (!segs.length) throw new Error("empty playlist");
  const win = segs.slice(-KEEP_SEGS);
  return renderLive(win, stableSeq(slug, win));
}

// ---- 两条直播通路 ----
async function viaJce(ch) {
  const now = Math.floor(Date.now() / 1e3);
  const m3u8 = await jceTimeshiftUrl(ch.pid, ch.sid, now - JCE_WINDOW, now, ch.defn);
  const { text, final } = await fetchMediaPlaylist(m3u8, H_JCE);
  return buildLive(ch.slug, text, final);
}

async function viaBk(ch) {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = bkUrls.get(ch.slug);
    const cached = attempt === 0 && c && Date.now() - c.t < BK_URL_TTL;
    const urls = cached ? c.urls : await bkPlayUrls(ch.sid, ch.pid, ch.defn);
    if (!cached) bkUrls.set(ch.slug, { t: Date.now(), urls });
    try {
      const { text, final } = await Promise.any(urls.slice(0, 3).map((u) => fetchMediaPlaylist(u, H_BK)));
      return absolutize(text, final);
    } catch (e) {
      last = errMsg(e.errors ? e.errors[0] : e);
      if (!cached) break;
    }
  }
  bkUrls.delete(ch.slug);
  throw new Error(last || "bk playlist failed");
}

async function livePlaylist(ch) {
  const now = Date.now();
  let order;
  let note = "";
  if (FORCE_BK.has(ch.slug)) order = ["bk"];
  else if (cfg.mode === "bk") order = ["bk", "jce"];
  else if (cfg.mode === "auto" && (sticky.get(ch.slug) || 0) > now) { order = ["bk", "jce"]; note = "sticky->bk"; }
  else order = ["jce", "bk"];

  const errs = [];
  for (const m of order) {
    try {
      const pl = m === "bk" ? await viaBk(ch) : await viaJce(ch);
      return { pl, mode: m, note: errs.length ? errs.join(" | ").slice(0, 160) : note };
    } catch (e) {
      errs.push(`${m}: ${errMsg(e)}`);
      if (m === "jce" && cfg.mode === "auto") sticky.set(ch.slug, Date.now() + STICKY_MS);
    }
  }
  throw new Error(errs.join(" | "));
}

function cachedLive(ch) {
  const m = memo.get(ch.slug);
  if (m && m.pl && Date.now() - m.t < PLAYLIST_TTL) return Promise.resolve({ ...m, hit: true });
  if (m && m.p) return m.p.then((r) => ({ ...r, hit: true }));
  const p = livePlaylist(ch).then(
    (r) => {
      memo.set(ch.slug, { t: Date.now(), pl: r.pl, mode: r.mode, note: r.note });
      return r;
    },
    (e) => {
      const old = memo.get(ch.slug);
      memo.set(ch.slug, { t: old?.t || 0, pl: old?.pl, mode: old?.mode, note: old?.note });
      if (old?.pl && Date.now() - old.t < STALE_TTL) return { ...old, hit: true, stale: true, note: errMsg(e).slice(0, 120) };
      throw e;
    }
  );
  memo.set(ch.slug, { t: m?.t || 0, pl: m?.pl, mode: m?.mode, note: m?.note, p });
  return p;
}

// ---- 回看 ----
const sumExtinf = (text) => { let t = 0; for (const m of text.matchAll(/#EXTINF:\s*([\d.]+)/g)) t += parseFloat(m[1]) || 0; return t; };
const countSegs = (text) => (text.match(/#EXTINF:/g) || []).length;
const transient = (e) => !!(e && (e.dead || e.name === "TimeoutError" || /HTTP 5\d\d|fetch failed|network/i.test(errMsg(e))));

async function jceRangeText(ch, start, end, defn) {
  const u = await jceTimeshiftUrl(ch.pid, ch.sid, start, end, defn, CU_JACC_TIMEOUT);
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
      } catch (e) { last = e; if (!transient(e)) break; }
    }
  }
  throw last;
}

// 分段兜底: 上游对长区间报错/截断时, 按 CU_CHUNK 切段并发申请再拼接
// [FIX] 提取分片 URL 末尾真实文件名(忽略路径中每次变化的 200 位动态加密 Token)进行去重, 消除分段交界处重复切片引起的色块卡顿
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
  try { whole = await catchupWhole(ch, start, end); } catch (e) { err = e; }
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

function cachedCatchup(ch, cu) {
  const key = `${ch.slug}|${cu.start}|${cu.end}`;
  const hit = cuCache.get(key);
  if (hit && Date.now() - hit.t < CU_CACHE_TTL) return hit.p;
  const p = catchupPlaylist(ch, cu.start, cu.end);
  if (!cu.open) {
    cuCache.set(key, { t: Date.now(), p });
    p.catch(() => { if (cuCache.get(key)?.p === p) cuCache.delete(key); });
    if (cuCache.size > 40) cuCache.delete(cuCache.keys().next().value);
  }
  return p;
}

// ---- /all.m3u ----
function allM3u(origin, sp, tokenQs) {
  const group = sp.get("group");
  const only4k = ["1", "true", "yes"].includes((sp.get("k4") || "0").toLowerCase());
  const mode = (sp.get("mode") || "").toLowerCase();
  const tzQ = (sp.get("tz") || "").trim();
  const sep = tokenQs ? "&" : "?";
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
    const chUrl = `${origin}/${c.slug}.m3u8${tokenQs}`;
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
const stripQ = (u) => String(u).split("?")[0];
const hostOf = (u) => { try { return new URL(u).host; } catch { return "?"; } };
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
async function debugChannel(ch, cu) {
  const out = { channel: ch.slug, version: VERSION, mode: cfg.mode, guid: GUID.slice(0, 6) + "…", forceBk: FORCE_BK.has(ch.slug), stickyUntil: sticky.get(ch.slug) || 0 };
  const t0 = Date.now();
  try {
    const now = Math.floor(Date.now() / 1e3);
    const u = await jceTimeshiftUrl(ch.pid, ch.sid, now - JCE_WINDOW, now, ch.defn);
    const { text, final } = await fetchMediaPlaylist(u, H_JCE);
    const segs = parseMedia(text, final);
    out.jce = { ok: true, ms: Date.now() - t0, m3u8: stripQ(u), segments: segs.length, hasPdt: !!segs[0]?.pdt, firstSeg: segs[0] && stripQ(segs[0].url), seq: segs.length ? stableSeq(ch.slug, segs.slice(-KEEP_SEGS)) : null, head: text.split(/\r?\n/).slice(0, 8) };
  } catch (e) { out.jce = { ok: false, ms: Date.now() - t0, error: errMsg(e) }; }
  const t1 = Date.now();
  try {
    const urls = await bkPlayUrls(ch.sid, ch.pid, ch.defn);
    const { text, final } = await fetchMediaPlaylist(urls[0], H_BK);
    const segs = parseMedia(text, final);
    out.bk = { ok: true, ms: Date.now() - t1, urls: urls.map(stripQ), segments: segs.length, firstSeg: segs[0] && stripQ(segs[0].url), head: text.split(/\r?\n/).slice(0, 8) };
  } catch (e) { out.bk = { ok: false, ms: Date.now() - t1, error: errMsg(e) }; }

  const now2 = Math.floor(Date.now() / 1e3);
  const own = !!(cu && !cu.bad);
  const rq = own ? cu : { start: now2 - 2400, end: now2 - 600 };
  const t2 = Date.now();
  const cd = { selfTest: !own, supported: TIMESHIFT_SUPPORTED.has(ch.slug), tz: cfg.tz, start: rq.start, end: rq.end, startBJ: fmtBJ(rq.start), endBJ: fmtBJ(rq.end), spanSec: rq.end - rq.start };
  if (cu && cu.bad) cd.paramError = cu.bad;
  out.catchup = cd;
  try {
    const u = await jceTimeshiftUrl(ch.pid, ch.sid, rq.start, rq.end, ch.defn, CU_JACC_TIMEOUT);
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
      if (bad) cd.hint = "播放列表拿到了, 但分片本身取不到: 多半是分片地址有时效/防盗链/出口 IP 限制 (first 与 last 状态不同则说明地址有时效或该时段无录像)";
      else if (cd.coverage !== null && cd.coverage < 0.9) cd.hint = "上游只返回了部分时长, 实际回看会自动走分段拼接兜底";
      else if (cd.scheme === "http") cd.hint = "分片是明文 http://: 直播同样如此, 若直播能播则不是问题; 浏览器/iOS ATS 类播放器可能拦截";
    }
  } catch (e) {
    cd.ok = false;
    cd.ms = Date.now() - t2;
    cd.error = errMsg(e);
    if (e.dead) cd.hint = `JACC 返回了已失效的 CDN 域名 (${e.host}), 回看会自动重试/换清晰度; 若始终如此则是上游限制`;
    else if (/errCode|ret|code/i.test(cd.error)) cd.hint = "JACC 明确拒绝了该请求: 常见原因是超出回看保留期、节目时间段无录像, 或出口 IP/地区受限";
    else if (e.name === "TimeoutError") cd.hint = "请求 JACC/CDN 超时: 可能是出口节点到上游网络质量差";
  }
  return reply(JSON.stringify(out, null, 2), 200, "application/json; charset=utf-8");
}

// ---- 入口 ----
export default {
  async fetch(request, env, ctx) {
    env = env || {};
    opts.nativeGzip = env.NATIVE_GZIP === "1";
    cfg.mode = env.LIVE_MODE === "jce" || env.LIVE_MODE === "bk" ? env.LIVE_MODE : "auto";
    const ipTz = request.cf?.timezone || null;
    const envTz = String(env.CATCHUP_TZ || "").trim();
    const tzDefault = envTz.toLowerCase() === "auto" ? parseTz(ipTz, 480) : parseTz(envTz, 480);
    cfg.tz = tzDefault;
    const mx = Number(env.CATCHUP_MAX);
    cfg.max = mx >= 600 && mx <= 43200 ? mx : 14400; // 默认回看最大跨度 14400 秒 (4 小时)
    initGuid(env.GUID);

    const url = new URL(request.url);
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
        `2. ynoTV (Windows) / TiviMate / Kodi 订阅:\n   ${url.origin}/all.m3u${qs}${sp2}mode=utc\n\n` +
        `3. EPG 节目单:\n   ${url.origin}/epg.xml${qs}\n   ${url.origin}/epg.xml.gz${qs}\n\n` +
        `4. 仅 4K/8K 频道:\n   ${url.origin}/all.m3u${qs}${sp2}k4=1\n\n` +
        `5. 排障:\n   ${url.origin}/health${qs}\n   ${url.origin}/last${qs}\n   ${url.origin}/cctv1.m3u8${qs}${sp2}debug=1\n` +
        (authed || !env.TOKEN ? "" : "\n(已设置 TOKEN: 请把上面的 \"你的TOKEN\" 换成真实口令)\n")
      );
    }
    if (path === "/favicon.ico") return reply('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📺</text></svg>', 200, "image/svg+xml");
    if (path === "/health") {
      return reply(JSON.stringify({ ok: true, version: VERSION, mode: cfg.mode, channels: CHANNELS.length, catchupTz: cfg.tz, catchupMax: cfg.max, ipTz, colo: request.cf?.colo || null, routes: ["/all.m3u", "/all.m3u?mode=utc", "/epg.xml", "/epg.xml.gz", "/health", "/last", "/<channel>.m3u8"] }, null, 2), 200, "application/json; charset=utf-8");
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
    if (sp.has("debug")) return debugChannel(ch, cu);

    const t0 = Date.now();
    const hasParams = [...sp.keys()].some((k) => k !== "token");
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
        const r = await cachedCatchup(ch, cu);
        return note(new Response(r.pl, {
          status: 200,
          headers: {
            "Content-Type": M3U8,
            "Cache-Control": "no-cache",
            "X-Catchup": `${cu.start}-${cu.end}`,
            "X-Catchup-Mode": r.mode,
            "X-Catchup-Segs": String(r.segs),
            "X-Catchup-Dur": String(Math.round(r.dur)),
            ...(r.gaps ? { "X-Catchup-Gaps": String(r.gaps) } : {}),
            ...CORS,
          },
        }), { ...asked, mode: r.mode, segs: r.segs });
      } catch (e) {
        return note(reply(`回看失败 ${ch.name} ${fmtBJ(cu.start)} ~ ${fmtBJ(cu.end)} (${errMsg(e)})\n可访问 ${url.origin}/${slug}.m3u8${tokenQs ? tokenQs + "&" : "?"}debug=1 查看诊断\n`, 502), { ...asked, error: errMsg(e).slice(0, 160) });
      }
    }

    // 直播
    try {
      const r = await cachedLive(ch);
      return note(new Response(r.pl, {
        status: 200,
        headers: {
          "Content-Type": M3U8,
          "Cache-Control": "no-cache",
          "X-Mode": r.mode,
          "X-Cache": r.hit ? "HIT" : "MISS",
          ...(r.stale ? { "X-Stale": "1" } : {}),
          ...(r.note ? { "X-Fallback-Reason": r.note.replace(/[^\x20-\x7e]/g, "?") } : {}),
          ...CORS,
        },
      }), { mode: r.mode });
    } catch (e) {
      return note(reply(`频道 ${ch.name} 暂无数据 (${errMsg(e)}), 请稍后重试\n`, 503, "text/plain; charset=utf-8", { "Retry-After": "2" }), { error: errMsg(e).slice(0, 160) });
    }
  },
};