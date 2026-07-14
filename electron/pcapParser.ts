// electron/pcapParser.ts
// 미디어 플레이어 — pcap/pcapng 파일에서 RTP 스트림을 찾아 목록화하고, 선택된 스트림의
// 페이로드를 시퀀스 번호 순으로 이어 붙여 재생 가능한 임시 파일로 만든다.
//
// 지원 코덱: A-law/u-law(RFC 3551 정적 PT 8/0, 그대로 이어붙임), AMR-NB/AMR-WB(RFC 4867
// octet-aligned RTP → CMR 제거 + ToC의 F비트 마스킹 후 저장 포맷으로), EVS(3GPP TS 26.445
// Annex A — header-full 은 이미 [ToC][speech] 라 그대로, compact 는 페이로드 길이로 프레임
// 타입을 역산해 ToC 바이트를 합성), OPUS(RFC 7587 raw Opus 패킷을 RFC 7845 Ogg 컨테이너로 조립).
//
// 동적 페이로드 타입(96+)은 SDP 없이는 pcap만으로 코덱을 확정할 수 없어(Wireshark도 동일한
// 한계), 정적 타입(0/8)만 자동 감지하고 그 외에는 사용자가 UI에서 코덱을 직접 지정한다.
import fs from 'fs';
import path from 'path';
import os from 'os';

export type RtpPayloadCodec = 'alaw' | 'ulaw' | 'amrnb' | 'amrwb' | 'evs' | 'opus' | 'unsupported';
export type EvsRtpFormat = 'header-full' | 'compact';

export type RtpStreamInfo = {
  id: string; // `${srcIp}:${srcPort}->${dstIp}:${dstPort}/${ssrc}`
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  ssrc: number;
  payloadType: number;
  codec: RtpPayloadCodec; // 정적 PT(0/8) 는 자동 감지값, 동적 PT 는 'unsupported'(사용자가 UI 드롭다운에서 지정)
  packetCount: number;
  durationSec: number;
};

type RawPacket = {
  tsSec: number;
  tsUsec: number;
  data: Buffer; // 캡처된 프레임 원본(링크 레이어 포함)
};

const PCAP_MAGIC_LE = 0xa1b2c3d4;
const PCAP_MAGIC_LE_NS = 0xa1b23c4d;
const PCAP_MAGIC_BE = 0xd4c3b2a1;
const PCAP_MAGIC_BE_NS = 0x4d3cb2a1;
const PCAPNG_BLOCK_SHB = 0x0a0d0d0a;

// RFC 3551 정적 페이로드 타입만 자동 감지 — 그 외(동적 PT 96~127 등)는 사용자가 지정.
function payloadCodecForType(pt: number): RtpPayloadCodec {
  if (pt === 8) return 'alaw';
  if (pt === 0) return 'ulaw';
  return 'unsupported';
}

function ipv4ToString(buf: Buffer, offset: number): string {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

// ── classic pcap (libpcap) 파싱 ──
function parseClassicPcap(buf: Buffer): { packets: RawPacket[]; linkType: number } {
  const magic = buf.readUInt32LE(0);
  let littleEndian: boolean;
  let nsResolution = false;
  if (magic === PCAP_MAGIC_LE) littleEndian = true;
  else if (magic === PCAP_MAGIC_LE_NS) { littleEndian = true; nsResolution = true; }
  else if (magic === PCAP_MAGIC_BE) littleEndian = false;
  else if (magic === PCAP_MAGIC_BE_NS) { littleEndian = false; nsResolution = true; }
  else throw new Error('pcap 매직 넘버를 인식할 수 없습니다.');

  const r32 = (o: number) => (littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

  // global header: magic(4) version_major(2) version_minor(2) thiszone(4) sigfigs(4) snaplen(4) network(4) = 24
  const linkType = r32(20);
  const packets: RawPacket[] = [];
  let offset = 24;
  while (offset + 16 <= buf.length) {
    const tsSec = r32(offset);
    const tsSubsec = r32(offset + 4);
    const inclLen = r32(offset + 8);
    // orig_len at offset+12, 사용 안 함
    offset += 16;
    if (offset + inclLen > buf.length) break;
    const data = buf.subarray(offset, offset + inclLen);
    offset += inclLen;
    const tsUsec = nsResolution ? Math.floor(tsSubsec / 1000) : tsSubsec;
    packets.push({ tsSec, tsUsec, data });
  }
  return { packets, linkType };
}

// ── pcapng 파싱 (단순화: EPB/SPB 블록만 처리, 인터페이스 링크 타입은 IDB 에서 읽음) ──
function parsePcapng(buf: Buffer): { packets: RawPacket[]; linkType: number } {
  let littleEndian = true;
  const packets: RawPacket[] = [];
  const interfaceLinkTypes: number[] = [];
  let offset = 0;
  let tsResolPerIf: number[] = []; // if_tsresol 미지원 시 기본 1e6(us) 가정

  while (offset + 12 <= buf.length) {
    // 각 블록: block_type(4) block_total_length(4) ... block_total_length(4, 끝에 반복)
    const blockTypeRaw = buf.readUInt32LE(offset);
    let blockType = blockTypeRaw;
    let r32 = (o: number) => buf.readUInt32LE(o);
    let r16 = (o: number) => buf.readUInt16LE(o);

    if (blockType === PCAPNG_BLOCK_SHB) {
      // SHB 안의 byte-order magic 으로 엔디안 확정
      const bom = buf.readUInt32LE(offset + 8);
      if (bom === 0x1a2b3c4d) littleEndian = true;
      else if (bom === 0x4d3c2b1a) littleEndian = false;
      r32 = littleEndian ? (o: number) => buf.readUInt32LE(o) : (o: number) => buf.readUInt32BE(o);
      r16 = littleEndian ? (o: number) => buf.readUInt16LE(o) : (o: number) => buf.readUInt16BE(o);
    } else {
      r32 = littleEndian ? (o: number) => buf.readUInt32LE(o) : (o: number) => buf.readUInt32BE(o);
      r16 = littleEndian ? (o: number) => buf.readUInt16LE(o) : (o: number) => buf.readUInt16BE(o);
      blockType = r32(offset);
    }

    const blockLen = r32(offset + 4);
    if (blockLen < 12 || offset + blockLen > buf.length) break;

    if (blockType === 0x00000001) {
      // Interface Description Block: block_type(4) block_len(4) linktype(2) reserved(2) snaplen(4) [options] block_len(4)
      const linkType = r16(offset + 8);
      interfaceLinkTypes.push(linkType);
      tsResolPerIf.push(1e6); // 옵션 파싱 생략, 기본 마이크로초 단위 가정(대부분의 캡처 도구 기본값)
    } else if (blockType === 0x00000006) {
      // Enhanced Packet Block: block_type(4) block_len(4) if_id(4) ts_high(4) ts_low(4) cap_len(4) orig_len(4) data...
      const ifId = r32(offset + 8);
      const tsHigh = r32(offset + 12);
      const tsLow = r32(offset + 16);
      const capLen = r32(offset + 20);
      const dataStart = offset + 28;
      if (dataStart + capLen > buf.length) break;
      const data = buf.subarray(dataStart, dataStart + capLen);
      const tsResol = tsResolPerIf[ifId] || 1e6;
      const tsCombined = tsHigh * 0x100000000 + tsLow; // 64bit 타임스탬프(지정된 단위)
      const tsSec = Math.floor(tsCombined / tsResol);
      const tsUsec = Math.floor((tsCombined % tsResol) * (1e6 / tsResol));
      packets.push({ tsSec, tsUsec, data });
    } else if (blockType === 0x00000003) {
      // Simple Packet Block: block_type(4) block_len(4) orig_len(4) data...
      const capLen = blockLen - 16; // block_len - (type+len+origlen+trailing len)
      const dataStart = offset + 12;
      if (dataStart + capLen > buf.length) break;
      const data = buf.subarray(dataStart, dataStart + capLen);
      packets.push({ tsSec: 0, tsUsec: 0, data });
    }
    // 그 외 블록 타입(NRB, ISB, 커스텀 등)은 건너뜀

    offset += blockLen;
  }

  // pcapng 는 인터페이스별로 링크 타입이 다를 수 있지만, 이 앱의 용도(RTP 스트림 찾기)에서는
  // 대부분 단일 인터페이스 캡처이므로 첫 인터페이스의 링크 타입만 사용한다.
  return { packets, linkType: interfaceLinkTypes[0] ?? 1 };
}

function parsePcapAny(buf: Buffer): { packets: RawPacket[]; linkType: number } {
  if (buf.length < 4) throw new Error('파일이 너무 작습니다.');
  const magic32le = buf.readUInt32LE(0);
  if (magic32le === PCAPNG_BLOCK_SHB) return parsePcapng(buf);
  if (
    magic32le === PCAP_MAGIC_LE || magic32le === PCAP_MAGIC_LE_NS ||
    magic32le === PCAP_MAGIC_BE || magic32le === PCAP_MAGIC_BE_NS
  ) return parseClassicPcap(buf);
  throw new Error('pcap 또는 pcapng 형식이 아닙니다.');
}

// LINKTYPE_ETHERNET=1, LINKTYPE_LINUX_SLL=113, LINKTYPE_RAW=101 정도만 지원 —
// 그 외는 이더넷으로 가정하고 시도(실패 시 해당 패킷만 건너뜀).
function stripLinkLayer(data: Buffer, linkType: number): { ethertype: number; payload: Buffer } | null {
  if (linkType === 101) {
    // LINKTYPE_RAW: 링크 레이어 없이 바로 IP
    if (data.length < 1) return null;
    const version = data[0] >> 4;
    return { ethertype: version === 6 ? 0x86dd : 0x0800, payload: data };
  }
  if (linkType === 113) {
    // Linux "cooked" capture (SLL): 16바이트 고정 헤더, 마지막 2바이트가 프로토콜 타입
    if (data.length < 16) return null;
    const ethertype = data.readUInt16BE(14);
    return { ethertype, payload: data.subarray(16) };
  }
  // LINKTYPE_ETHERNET(1) 및 기본값
  if (data.length < 14) return null;
  let offset = 12;
  let ethertype = data.readUInt16BE(offset);
  offset += 2;
  // 802.1Q VLAN 태그 스킵(중첩 허용)
  while (ethertype === 0x8100 || ethertype === 0x88a8) {
    if (offset + 4 > data.length) return null;
    ethertype = data.readUInt16BE(offset + 2);
    offset += 4;
  }
  return { ethertype, payload: data.subarray(offset) };
}

function parseIPv4Udp(payload: Buffer): { srcIp: string; dstIp: string; srcPort: number; dstPort: number; udpPayload: Buffer } | null {
  if (payload.length < 20) return null;
  const versionIhl = payload[0];
  const version = versionIhl >> 4;
  if (version !== 4) return null;
  const ihl = (versionIhl & 0x0f) * 4;
  if (ihl < 20 || payload.length < ihl) return null;
  const protocol = payload[9];
  if (protocol !== 17) return null; // UDP 만
  const srcIp = ipv4ToString(payload, 12);
  const dstIp = ipv4ToString(payload, 16);
  const udpStart = ihl;
  if (payload.length < udpStart + 8) return null;
  const srcPort = payload.readUInt16BE(udpStart);
  const dstPort = payload.readUInt16BE(udpStart + 2);
  const udpLen = payload.readUInt16BE(udpStart + 4);
  const udpPayloadStart = udpStart + 8;
  const udpPayloadEnd = Math.min(udpStart + udpLen, payload.length);
  if (udpPayloadEnd <= udpPayloadStart) return null;
  return { srcIp, dstIp, srcPort, dstPort, udpPayload: payload.subarray(udpPayloadStart, udpPayloadEnd) };
}

type RtpHeader = { version: number; payloadType: number; seq: number; timestamp: number; ssrc: number; headerLen: number };

function parseRtpHeader(buf: Buffer): RtpHeader | null {
  if (buf.length < 12) return null;
  const b0 = buf[0];
  const version = b0 >> 6;
  if (version !== 2) return null; // RTP 버전 2 만 인식 — 오탐(다른 UDP 트래픽) 배제용 핵심 체크
  const hasPadding = (b0 & 0x20) !== 0;
  const hasExtension = (b0 & 0x10) !== 0;
  const csrcCount = b0 & 0x0f;
  const b1 = buf[1];
  const payloadType = b1 & 0x7f;
  const seq = buf.readUInt16BE(2);
  const timestamp = buf.readUInt32BE(4);
  const ssrc = buf.readUInt32BE(8);
  let headerLen = 12 + csrcCount * 4;
  if (hasExtension) {
    if (buf.length < headerLen + 4) return null;
    const extLen = buf.readUInt16BE(headerLen + 2);
    headerLen += 4 + extLen * 4;
  }
  if (headerLen > buf.length) return null;
  void hasPadding;
  return { version, payloadType, seq, timestamp, ssrc, headerLen };
}

type StreamAccum = {
  info: RtpStreamInfo;
  packets: { seq: number; payload: Buffer; tsSec: number; tsUsec: number }[];
};

function collectStreams(packets: RawPacket[], linkType: number): Map<string, StreamAccum> {
  const streams = new Map<string, StreamAccum>();
  for (const pkt of packets) {
    const link = stripLinkLayer(pkt.data, linkType);
    if (!link || link.ethertype !== 0x0800) continue; // IPv4 만(1차 구현 범위)
    const ip = parseIPv4Udp(link.payload);
    if (!ip) continue;
    const rtp = parseRtpHeader(ip.udpPayload);
    if (!rtp) continue;

    const key = `${ip.srcIp}:${ip.srcPort}->${ip.dstIp}:${ip.dstPort}/${rtp.ssrc}`;
    let stream = streams.get(key);
    if (!stream) {
      stream = {
        info: {
          id: key,
          srcIp: ip.srcIp,
          srcPort: ip.srcPort,
          dstIp: ip.dstIp,
          dstPort: ip.dstPort,
          ssrc: rtp.ssrc,
          payloadType: rtp.payloadType,
          codec: payloadCodecForType(rtp.payloadType),
          packetCount: 0,
          durationSec: 0,
        },
        packets: [],
      };
      streams.set(key, stream);
    }
    const payload = ip.udpPayload.subarray(rtp.headerLen);
    if (payload.length === 0) continue;
    stream.packets.push({ seq: rtp.seq, payload, tsSec: pkt.tsSec, tsUsec: pkt.tsUsec });
    stream.info.packetCount++;
  }
  return streams;
}

export function probePcapFile(filePath: string): RtpStreamInfo[] {
  const buf = fs.readFileSync(filePath);
  const { packets, linkType } = parsePcapAny(buf);
  const streams = collectStreams(packets, linkType);

  const result: RtpStreamInfo[] = [];
  for (const stream of streams.values()) {
    if (stream.packets.length === 0) continue;
    const first = stream.packets[0];
    const last = stream.packets[stream.packets.length - 1];
    const durationSec = (last.tsSec - first.tsSec) + (last.tsUsec - first.tsUsec) / 1e6;
    stream.info.durationSec = Math.max(0, durationSec);
    result.push(stream.info);
  }
  // 패킷 수가 많은(=유의미한 통화/스트림일 가능성이 높은) 순으로 정렬
  result.sort((a, b) => b.packetCount - a.packetCount);
  return result;
}

function sortBySeq<T extends { seq: number }>(items: T[]): T[] {
  const baseSeq = items[0].seq;
  return [...items].sort((a, b) => {
    const da = (a.seq - baseSeq + 0x10000) % 0x10000;
    const db = (b.seq - baseSeq + 0x10000) % 0x10000;
    return da - db;
  });
}

// ── AMR-NB/AMR-WB: RFC 4867 octet-aligned RTP → 3GPP 저장 포맷 ──
// RTP 페이로드 = [1바이트 CMR][ToC 1개 이상(F비트로 체이닝)][프레임 데이터...].
// 저장 포맷의 프레임 헤더 바이트는 RTP ToC 와 완전히 동일한 위치의 FT/Q 비트를 쓰되,
// bit0(F, follow) 는 저장 포맷에선 패딩(반드시 0)이므로 마스킹한다 — RFC 4867 §4.3.2/§5.3.
const AMR_NB_FT_SIZE = [12, 13, 15, 17, 19, 20, 26, 31, 5, 6, 5, 5, -1, -1, -1, 0]; // bytes, FT 0-15 (12.2k..1.95k, SID, ...)
const AMR_WB_FT_SIZE = [17, 23, 32, 36, 40, 46, 50, 58, 60, 5, -1, -1, -1, -1, 0, 0]; // bytes, FT 0-15

function amrFrameBytesForFt(ft: number, isWb: boolean): number {
  const table = isWb ? AMR_WB_FT_SIZE : AMR_NB_FT_SIZE;
  return table[ft] ?? -1;
}

function extractAmrPayloads(payload: Buffer, isWb: boolean): Buffer[] {
  // octet-aligned: 1바이트 CMR 로 시작.
  if (payload.length < 1) return [];
  let offset = 1; // CMR 스킵
  const tocs: number[] = [];
  while (offset < payload.length) {
    const toc = payload[offset];
    offset += 1;
    tocs.push(toc);
    if ((toc & 0x80) === 0) break; // F=0 이면 마지막 ToC
  }
  const frames: Buffer[] = [];
  for (const toc of tocs) {
    const ft = (toc >> 3) & 0x0f;
    const frameLen = amrFrameBytesForFt(ft, isWb);
    if (frameLen < 0 || offset + frameLen > payload.length) break;
    const storageToc = toc & 0x7f; // F 비트만 마스킹, FT/Q 위치는 그대로
    const frameData = payload.subarray(offset, offset + frameLen);
    frames.push(Buffer.concat([Buffer.from([storageToc]), frameData]));
    offset += frameLen;
  }
  return frames;
}

// ── EVS: 3GPP TS 26.445 Annex A ──
// header-full: RTP 페이로드가 이미 [ToC(H=0,F=0)][speech] 라 그대로 저장 포맷과 동일.
// compact: ToC 바이트가 없어 페이로드 길이로 프레임 타입을 역산해 ToC 를 합성해야 한다.
const EVS_PRIMARY_FT_SIZE = [7, 18, 20, 24, 33, 41, 61, 80, 120, 160, 240, 320, 6, -1, -1, 0];
const EVS_AMRWB_IO_FT_SIZE = [17, 23, 32, 36, 40, 46, 50, 58, 60, 5, -1, -1, -1, -1, 0, 0];

function evsCompactFtLookup(byteLen: number): { ft: number; isWbIo: boolean } | null {
  const primaryIdx = EVS_PRIMARY_FT_SIZE.indexOf(byteLen);
  if (primaryIdx >= 0 && byteLen > 0) return { ft: primaryIdx, isWbIo: false };
  const wbIdx = EVS_AMRWB_IO_FT_SIZE.indexOf(byteLen);
  if (wbIdx >= 0 && byteLen > 0) return { ft: wbIdx, isWbIo: true };
  return null;
}

function extractEvsPayloads(payload: Buffer, format: EvsRtpFormat): Buffer[] {
  if (format === 'header-full') {
    // [optional CMR(H=1)][ToC(H=0)][speech...] — CMR 바이트는 H 비트(0x80)로 구분.
    let offset = 0;
    if (payload.length > 0 && (payload[0] & 0x80) !== 0) offset = 1; // CMR 존재 시 스킵
    if (offset >= payload.length) return [];
    return [payload.subarray(offset)]; // [ToC][speech] 그대로 — 저장 포맷과 동일
  }
  // compact: ToC 없음 — 길이로 프레임 타입 역산 후 ToC 합성.
  const found = evsCompactFtLookup(payload.length);
  if (!found) return [];
  const toc = (found.isWbIo ? 0x20 : 0x00) | (found.ft & 0x0f);
  return [Buffer.concat([Buffer.from([toc]), payload])];
}

// ── OPUS: RFC 7587 raw Opus 패킷 → RFC 7845 최소 Ogg 컨테이너 ──
// Ogg CRC32 는 zlib/PNG 표준(0xEDB88320, init 0xFFFFFFFF)과 다르다 — 비반전(MSB-first),
// polynomial 0x04C11DB7, init 0, xorout 0 (Xiph 공식 프레이밍 스펙 그대로).
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let bit = 0; bit < 8; bit++) {
      r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc32(buf: Buffer): number {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

function buildOggPage(opts: {
  headerType: number; // bit1=BOS, bit2=EOS, bit0=continued
  granulePos: bigint;
  serial: number;
  seqNum: number;
  packets: Buffer[]; // 이 페이지에 담을 패킷들(각 패킷은 255 이하로 가정 — lacing 단순화)
}): Buffer {
  const segments: number[] = [];
  for (const p of opts.packets) {
    let remaining = p.length;
    while (remaining >= 255) { segments.push(255); remaining -= 255; }
    segments.push(remaining);
  }
  const body = Buffer.concat(opts.packets);
  const headerLen = 27 + segments.length;
  const page = Buffer.alloc(headerLen + body.length);
  page.write('OggS', 0, 'latin1');
  page[4] = 0; // stream structure version
  page[5] = opts.headerType;
  page.writeBigUInt64LE(opts.granulePos, 6);
  page.writeUInt32LE(opts.serial, 14);
  page.writeUInt32LE(opts.seqNum, 18);
  page.writeUInt32LE(0, 22); // CRC 자리, 아래서 계산 후 채움
  page[26] = segments.length;
  for (let i = 0; i < segments.length; i++) page[27 + i] = segments[i];
  body.copy(page, headerLen);
  const crc = oggCrc32(page);
  page.writeUInt32LE(crc, 22);
  return page;
}

function buildOggOpusContainer(opusPackets: Buffer[], sampleRate = 48000): Buffer {
  const serial = 0x50455045; // 'PEPE' — 임의 고정값(단일 스트림이라 충돌 우려 없음)

  // OpusHead (RFC 7845 §5.1): magic(8) version(1) channels(1) preskip(2 LE) inputRate(4 LE) gain(2 LE) mapFamily(1)
  const opusHead = Buffer.alloc(19);
  opusHead.write('OpusHead', 0, 'latin1');
  opusHead[8] = 1; // version
  opusHead[9] = 1; // channels(mono — 이 앱이 다루는 통화 음성은 항상 모노)
  opusHead.writeUInt16LE(0, 10); // pre-skip
  opusHead.writeUInt32LE(sampleRate, 12); // input sample rate(정보용)
  opusHead.writeInt16LE(0, 16); // output gain
  opusHead[18] = 0; // channel mapping family 0

  // OpusTags (RFC 7845 §5.2): magic(8) vendorLen(4 LE) vendor commentCount(4 LE)=0
  const vendor = Buffer.from('pepe-terminal-ssh', 'utf-8');
  const opusTags = Buffer.concat([
    Buffer.from('OpusTags', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(vendor.length, 0); return b; })(),
    vendor,
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0, 0); return b; })(),
  ]);

  const pages: Buffer[] = [];
  pages.push(buildOggPage({ headerType: 0x02, granulePos: 0n, serial, seqNum: 0, packets: [opusHead] }));
  pages.push(buildOggPage({ headerType: 0x00, granulePos: 0n, serial, seqNum: 1, packets: [opusTags] }));

  // 오디오 페이지 — 페이지당 세그먼트 255개 제한(대략 패킷 하나 20ms 기준 넉넉한 배치 수)을
  // 넘지 않도록 몇 개씩 묶는다. granule position 은 48kHz 기준 누적 샘플 수(RFC 7845 §4) —
  // 정확한 프레임 길이 파싱 없이 표준 20ms 프레임을 가정(이 앱이 다루는 통화 음성 캡처의 일반적 값).
  const FRAME_SAMPLES_48K = 960; // 20ms @ 48kHz
  const PACKETS_PER_PAGE = 50;
  let granule = 0n;
  let seqNum = 2;
  for (let i = 0; i < opusPackets.length; i += PACKETS_PER_PAGE) {
    const chunk = opusPackets.slice(i, i + PACKETS_PER_PAGE);
    granule += BigInt(chunk.length * FRAME_SAMPLES_48K);
    const isLast = i + PACKETS_PER_PAGE >= opusPackets.length;
    pages.push(buildOggPage({ headerType: isLast ? 0x04 : 0x00, granulePos: granule, serial, seqNum: seqNum++, packets: chunk }));
  }

  return Buffer.concat(pages);
}

export type ExtractOptions = {
  forcedCodec?: RtpPayloadCodec; // 사용자가 UI 드롭다운에서 지정한 코덱(동적 PT 대응)
  evsFormat?: EvsRtpFormat; // codec==='evs' 일 때만 사용, 기본 'header-full'
};

/**
 * 지정된 RTP 스트림의 페이로드를 시퀀스 번호 순으로 정렬해 재조립하고, 기존 재생
 * 파이프라인(mediaCodec.ts 의 decodeLocalCodec/GStreamer 사이드카)이 그대로 처리 가능한
 * 임시 파일로 저장한다.
 */
export function extractRtpStreamToTemp(filePath: string, streamId: string, options?: ExtractOptions): { tempPath: string; codec: Exclude<RtpPayloadCodec, 'unsupported'> } {
  const buf = fs.readFileSync(filePath);
  const { packets, linkType } = parsePcapAny(buf);
  const streams = collectStreams(packets, linkType);
  const stream = streams.get(streamId);
  if (!stream || stream.packets.length === 0) throw new Error('해당 스트림의 패킷을 찾을 수 없습니다.');

  const codec = options?.forcedCodec && options.forcedCodec !== 'unsupported' ? options.forcedCodec : stream.info.codec;
  if (codec === 'unsupported') throw new Error(`지원하지 않는 페이로드 타입입니다 (PT=${stream.info.payloadType}). 재생할 코덱을 목록에서 지정해 주세요.`);

  const sorted = sortBySeq(stream.packets);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepe-pcap-rtp-'));

  if (codec === 'alaw' || codec === 'ulaw') {
    const merged = Buffer.concat(sorted.map((p) => p.payload));
    const ext = codec === 'alaw' ? '.alaw' : '.ulaw';
    const tempPath = path.join(tempDir, `stream${ext}`);
    fs.writeFileSync(tempPath, merged);
    return { tempPath, codec };
  }

  if (codec === 'amrnb' || codec === 'amrwb') {
    const isWb = codec === 'amrwb';
    const frames: Buffer[] = [];
    for (const p of sorted) frames.push(...extractAmrPayloads(p.payload, isWb));
    if (frames.length === 0) throw new Error('AMR 프레임을 추출하지 못했습니다(페이로드 형식을 확인하세요).');
    const magic = Buffer.from(isWb ? '#!AMR-WB\n' : '#!AMR\n', 'latin1');
    const tempPath = path.join(tempDir, isWb ? 'stream.awb' : 'stream.amr');
    fs.writeFileSync(tempPath, Buffer.concat([magic, ...frames]));
    return { tempPath, codec };
  }

  if (codec === 'evs') {
    const format = options?.evsFormat || 'header-full';
    const frames: Buffer[] = [];
    for (const p of sorted) frames.push(...extractEvsPayloads(p.payload, format));
    if (frames.length === 0) throw new Error('EVS 프레임을 추출하지 못했습니다(형식을 확인하세요).');
    const magic = Buffer.from('#!EVS_MC1.0\n', 'latin1');
    const tempPath = path.join(tempDir, 'stream.evs');
    fs.writeFileSync(tempPath, Buffer.concat([magic, ...frames]));
    return { tempPath, codec };
  }

  if (codec === 'opus') {
    const oggBuf = buildOggOpusContainer(sorted.map((p) => p.payload));
    const tempPath = path.join(tempDir, 'stream.opus.ogg');
    fs.writeFileSync(tempPath, oggBuf);
    return { tempPath, codec };
  }

  throw new Error(`알 수 없는 코덱입니다: ${codec}`);
}
