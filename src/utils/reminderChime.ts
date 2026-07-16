// src/utils/reminderChime.ts
// 작업일지 알람용 차분한 알림음 — 파일 재생이 아니라 WebAudio 오실레이터로 그 자리에서
// 작곡한다(MicroSipWorkspace 의 DTMF/벨소리 패턴과 동일한 방식). 반복적인 삑삑거림이 아니라
// 부드러운 5음 상행 아르페지오(핸드벨/차임 느낌) 한 번만 울리고 끝난다.
let _ctx: AudioContext | null = null;
function ensureCtx(): AudioContext {
  if (!_ctx) _ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return _ctx;
}

export async function playReminderChime() {
  try {
    const ctx = ensureCtx();
    // 브라우저 자동재생 정책상 사용자 제스처 없이 뜬 AudioContext 는 'suspended' 상태로 시작할 수
    // 있다 — resume() 완료를 기다리지 않고 바로 스케줄하면 소리가 아예 안 들리므로 반드시 대기.
    if (ctx.state === 'suspended') await ctx.resume();
    const master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);
    // 펜타토닉 5음 상행(C-D-E-G-A, 옥타브 위) — 서로 부딪히는 음정이 없어 불협화음 없이 편안하다.
    const notes = [523.25, 587.33, 659.25, 783.99, 880.00];
    const noteGap = 0.16; // 초 — 톤이 살짝 겹치며 이어지도록
    const noteDur = 0.9;  // 각 음의 여운 길이
    notes.forEach((freq, i) => {
      const t0 = ctx.currentTime + i * noteGap;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      // 부드러운 어택(클릭음 방지) + 천천히 사라지는 릴리즈 — 종처럼 은은하게.
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(1, t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + noteDur);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t0);
      osc.stop(t0 + noteDur + 0.05);
    });
  } catch {}
}
