// src/components/MediaPcapStreamPicker.tsx
// pcap/pcapng 파일에서 발견된 RTP 스트림 목록을 보여주고 재생할 스트림을 선택하는 모달
// (Wireshark 의 Telephony > RTP Streams 창과 같은 역할). 정적 페이로드 타입(0/8) 은
// A-law/u-law 로 자동 인식되지만, 동적 타입(96+, AMR/EVS/OPUS 등)은 SDP 없이 pcap만으로는
// 코덱을 확정할 수 없어(Wireshark 도 동일한 한계) 사용자가 드롭다운에서 직접 지정한다.
import { useState } from 'react';

export type RtpPayloadCodec = 'alaw' | 'ulaw' | 'amrnb' | 'amrwb' | 'evs' | 'opus' | 'unsupported';
export type EvsRtpFormat = 'header-full' | 'compact';

export type RtpStreamInfo = {
  id: string;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  ssrc: number;
  payloadType: number;
  codec: RtpPayloadCodec;
  packetCount: number;
  durationSec: number;
  suggestedEvsFormat: EvsRtpFormat;
  suggestedCodec: RtpPayloadCodec;
};

const CODEC_OPTIONS: { value: RtpPayloadCodec; label: string }[] = [
  { value: 'alaw', label: 'A-law' },
  { value: 'ulaw', label: 'u-law' },
  { value: 'amrnb', label: 'AMR-NB' },
  { value: 'amrwb', label: 'AMR-WB' },
  { value: 'evs', label: 'EVS' },
  { value: 'opus', label: 'OPUS' },
];

function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

export function MediaPcapStreamPicker({ fileName, streams, error, onSelect, onCancel }: {
  fileName: string;
  streams: RtpStreamInfo[];
  error?: string | null;
  onSelect: (streamId: string, forcedCodec: RtpPayloadCodec, evsFormat: EvsRtpFormat) => void;
  onCancel: () => void;
}) {
  // 스트림별 사용자가 고른 코덱/EVS 형식 — 정적 PT 는 감지값을 기본 선택으로 미리 채운다.
  const [choice, setChoice] = useState<Record<string, { codec: RtpPayloadCodec; evsFormat: EvsRtpFormat }>>({});

  const choiceFor = (s: RtpStreamInfo) => choice[s.id] ?? { codec: s.suggestedCodec, evsFormat: s.suggestedEvsFormat };
  const setChoiceFor = (id: string, patch: Partial<{ codec: RtpPayloadCodec; evsFormat: EvsRtpFormat }>) => {
    setChoice((prev) => ({ ...prev, [id]: { ...choiceFor(streams.find((s) => s.id === id)!), ...prev[id], ...patch } }));
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}>
      <div style={{ width: 760, maxWidth: '90vw', minWidth: 0, maxHeight: '80vh', borderRadius: 10, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface, #161b22)', padding: 20, display: 'flex', flexDirection: 'column', gap: 12, boxSizing: 'border-box' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--win-text, #e6edf3)' }}>📡 RTP 스트림 선택</div>
        <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)', wordBreak: 'break-all' }}>
          <b>{fileName}</b> — {streams.length}개의 RTP 스트림을 찾았습니다. PT 0/8(A-law/u-law)은 자동 인식되며, 그 외에는 코덱을 직접 선택하세요.
        </div>
        {error && <div style={{ fontSize: 12, color: '#e5534b' }}>{error}</div>}
        <div style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 80, maxHeight: '55vh', border: '1px solid var(--win-border, #30363d)', borderRadius: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--win-bg, #0d1117)', color: 'var(--win-text-dim, #9aa7b3)', textAlign: 'left' }}>
                <th style={thStyle}>발신</th>
                <th style={thStyle}>수신</th>
                <th style={thStyle}>SSRC</th>
                <th style={thStyle}>PT</th>
                <th style={thStyle}>코덱</th>
                <th style={thStyle}>패킷 수</th>
                <th style={thStyle}>길이</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {streams.length === 0 && (
                <tr><td colSpan={8} style={{ ...tdStyle, textAlign: 'center', color: 'var(--win-text-dim, #9aa7b3)' }}>RTP 스트림을 찾지 못했습니다.</td></tr>
              )}
              {streams.map((s) => {
                const cur = choiceFor(s);
                const isStatic = s.codec !== 'unsupported';
                return (
                  <tr key={s.id} style={{ borderTop: '1px solid var(--win-border, #30363d)' }}>
                    <td style={tdStyle}>{s.srcIp}:{s.srcPort}</td>
                    <td style={tdStyle}>{s.dstIp}:{s.dstPort}</td>
                    <td style={tdStyle}>0x{s.ssrc.toString(16)}</td>
                    <td style={tdStyle}>{s.payloadType}{isStatic ? '' : ' (동적)'}</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <select
                          value={cur.codec}
                          onChange={(e) => setChoiceFor(s.id, { codec: e.target.value as RtpPayloadCodec })}
                          style={selStyle}
                          title={isStatic ? undefined : `페이로드 패턴으로 자동 추정: ${CODEC_OPTIONS.find(o => o.value === s.suggestedCodec)?.label ?? s.suggestedCodec}. SDP 없이는 확정할 수 없으니 재생이 이상하면 다른 코덱으로 바꿔보세요.`}
                        >
                          {CODEC_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}{!isStatic && s.suggestedCodec === o.value ? ' (추정)' : ''}
                            </option>
                          ))}
                        </select>
                        {cur.codec === 'evs' && (
                          <select
                            value={cur.evsFormat}
                            onChange={(e) => setChoiceFor(s.id, { evsFormat: e.target.value as EvsRtpFormat })}
                            style={selStyle}
                            title={`EVS RTP 페이로드 형식 — 페이로드 길이로 자동 추정: ${s.suggestedEvsFormat}. 재생이 안 되면 반대 형식으로 바꿔보세요.`}
                          >
                            <option value="header-full">header-full{s.suggestedEvsFormat === 'header-full' ? ' (추정)' : ''}</option>
                            <option value="compact">compact{s.suggestedEvsFormat === 'compact' ? ' (추정)' : ''}</option>
                          </select>
                        )}
                      </div>
                    </td>
                    <td style={tdStyle}>{s.packetCount}</td>
                    <td style={tdStyle}>{fmtDuration(s.durationSec)}</td>
                    <td style={tdStyle}>
                      <button
                        onClick={() => onSelect(s.id, cur.codec, cur.evsFormat)}
                        style={{
                          padding: '3px 10px', borderRadius: 6, border: 'none',
                          background: 'var(--win-accent, #2b6b9b)',
                          color: '#fff', fontSize: 12, cursor: 'pointer',
                        }}
                      >재생</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)', background: 'transparent', color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer' }}
          >닫기</button>
        </div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: '6px 8px', fontWeight: 600 };
const tdStyle: React.CSSProperties = { padding: '6px 8px', color: 'var(--win-text, #e6edf3)' };
const selStyle: React.CSSProperties = {
  padding: '3px 6px', borderRadius: 4, border: '1px solid var(--win-border, #30363d)',
  background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', fontSize: 11,
};
