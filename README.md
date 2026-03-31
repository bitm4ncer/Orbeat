**orbitrack**

polyrhythmic orbital web sequencer

arrange instruments on a circular grid, sequence them on a step
sequencer, shape the sound with a synth panel or sample bank,
and process through a per-instrument effects chain.

[https://orbitrack.app](orbitrack.app)

---

**features**

- polyrhythmic step sequencer on a circular grid
- synth engine + sample bank per instrument
- per-orbit effects chain (eq, chorus, phaser, filter, distortion, reverb, delay)
- audio input recording from mic / interface (mono & stereo, monitor mode)
- midi i/o — clock sync (in/out), cc learn for any knob, note input & recording
- url track sharing, .orb file export/import
- ai-assisted pattern generation (ollama / claude / custom llm)

---

**stack**

| layer        | tool                   |
|--------------|------------------------|
| ui           | react 19 + typescript  |
| styling      | tailwind css v4        |
| build        | vite                   |
| state        | zustand                |
| scheduling   | tone.js                |
| synthesis    | superdough             |
| dsp          | web audio api          |
| deploy       | gh-pages               |

---

```
npm install
npm run dev
```
