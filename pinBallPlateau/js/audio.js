// BGM（ループ再生）と、破壊時の効果音（Web Audio API で合成）。
// 効果音は外部素材を使わずにその場で作るので、素材のライセンス確認が要らない。
// ブラウザの自動再生制限により、最初のクリック・キー入力で unlock() を呼ぶまで鳴らない。

const SE_MIN_INTERVAL = 0.045; // 同時多発時はこの間隔でまとめて1回にする [s]

export class Sound {
  constructor({ bgmUrl }) {
    this.bgmUrl = bgmUrl;
    this.ctx = null;
    this.bgmGain = null;
    this.seGain = null;
    this.bgmVolume = 0.5;
    this.seVolume = 0.7;
    this.muted = false;
    this.pending = 0;      // まとめ待ちの効果音の強さ（最大値）
    this.lastSe = 0;
  }

  async unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const ctx = (this.ctx = new AudioContext());
    // 破壊が重なっても割れないようにコンプレッサーを通す
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(comp);
    this.bgmGain = ctx.createGain();
    this.seGain = ctx.createGain();
    this.bgmGain.connect(this.master);
    this.seGain.connect(this.master);
    this.applyVolumes();

    // 白色雑音（1 秒分）を使い回す
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;

    // AudioBuffer でループさせる（<audio loop> より継ぎ目の隙間が小さい）
    try {
      const buf = await fetch(this.bgmUrl).then((r) => r.arrayBuffer());
      const audio = await ctx.decodeAudioData(buf);
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.loop = true;
      src.connect(this.bgmGain);
      src.start();
      this.bgm = src;
    } catch (e) {
      console.warn('BGM を読み込めませんでした', e);
    }
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.05);
    this.bgmGain.gain.setTargetAtTime(this.bgmVolume * 0.6, t, 0.05);
    this.seGain.gain.setTargetAtTime(this.seVolume, t, 0.05);
  }

  setBgmVolume(v) { this.bgmVolume = v; this.applyVolumes(); }
  setSeVolume(v) { this.seVolume = v; this.applyVolumes(); }
  setMuted(m) { this.muted = m; this.applyVolumes(); }

  // strength: 0〜1（effects.js と同じ尺度。木造 ≈ 0.3、SRC ≈ 1）
  destruction(strength) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.pending = Math.max(this.pending, strength);
  }

  // 毎フレーム呼ぶ。まとめた強さで1回鳴らす
  update() {
    if (!this.pending || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastSe < SE_MIN_INTERVAL) return;
    this.play(this.pending, now);
    this.pending = 0;
    this.lastSe = now;
  }

  play(s, t) {
    const ctx = this.ctx;
    const pitch = 0.85 + Math.random() * 0.3;

    // 崩れる音：帯域通過した雑音。弱い（木造）ほど高く短く、強い（RC）ほど低く長い
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.playbackRate.value = pitch;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime((2600 - 1900 * s) * pitch, t);
    bp.frequency.exponentialRampToValueAtTime((900 - 600 * s) * pitch, t + 0.25 + 0.4 * s);
    bp.Q.value = 0.9;
    const ng = ctx.createGain();
    const dur = 0.14 + 0.6 * s;
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.35 + 0.5 * s, t + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    noise.connect(bp).connect(ng).connect(this.seGain);
    noise.start(t, Math.random() * 0.5, dur + 0.05);

    // 木造らしい乾いた破裂：短いクリックを数発
    const clicks = Math.round(2 + 3 * (1 - s));
    for (let k = 0; k < clicks; k++) {
      const c = ctx.createBufferSource();
      c.buffer = this.noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800 + Math.random() * 1500;
      const cg = ctx.createGain();
      const tc = t + Math.random() * (0.06 + 0.1 * s);
      cg.gain.setValueAtTime(0.0001, tc);
      cg.gain.exponentialRampToValueAtTime(0.25, tc + 0.002);
      cg.gain.exponentialRampToValueAtTime(0.0001, tc + 0.03);
      c.connect(hp).connect(cg).connect(this.seGain);
      c.start(tc, Math.random() * 0.8, 0.05);
    }

    // 重い建物：音程が下がる低音の衝撃
    if (s > 0.45) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(140 * pitch, t);
      osc.frequency.exponentialRampToValueAtTime(38, t + 0.35 + 0.3 * s);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.5 + 0.5 * s, t + 0.01);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.45 + 0.4 * s);
      osc.connect(og).connect(this.seGain);
      osc.start(t);
      osc.stop(t + 1);
    }
  }
}
