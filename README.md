# MOSHER

Realtime webcam datamosh + motion-audio instrument built with React, TypeScript, and Canvas.

Live URL: [https://curren.dev/mosher](https://curren.dev/mosher)

---

## What This App Does

Mosher is an interactive browser tool that takes a live webcam feed and applies glitch processing in two modes:

1. **Datamosh mode**  
   Holds a keyframe and pushes blocks using motion vectors so pixels drag and smear over time.
2. **Tracker Glitch mode**  
   Detects motion blobs, tracks them over time, overlays stylized trails/boxes, and can drive sound.

It is designed to feel like a terminal-style creative instrument: tune parameters, perform with body movement, and capture outputs.

---

## Core Features

### Camera + Rendering

- Device picker for available webcams (`enumerateDevices`).
- Enable/disable camera stream.
- Mirrored camera draw for expected webcam behavior.
- Requests the highest practical camera input (`ideal` up to 7680x4320).
- Keeps display aspect ratio tied to live source ratio.
- Uses source-resolution output canvas while processing internally at lower resolution for realtime performance.

### Datamosh Controls

- **Pixel Inject** (`$ pixel inject`)  
  Blend amount from current frame into held mosh frame.
- **Vector Push** (`$ vector push`)  
  Motion-vector block displacement strength.
- **Keyframe Refresh Interval** (`manual` or timed)  
  Controls when the held keyframe is replaced.
- **Refresh now** button (panel + canvas FAB in Datamosh mode)  
  Re-captures the held keyframe **without reconnecting camera stream**.
- Optional **Noise Reduction** pre-blur to stabilize motion signals.

### Tracker Controls

- **Motion sensitivity** threshold.
- **Max tracked boxes** cap (default tuned lower for cleaner tracking).
- **Show tracked boxes** toggle.
- Motion blob filtering + merging tuned to prioritize larger coherent objects over tiny noise fragments.

### Audio Features

- **Knock sound mode**  
  Plays transient per new tracked object.
- **Motion synth mode (polyphonic)**  
  Uses sample-based synthesis from:
  - `public/sounds/heaven-synth-451981.mp3`
- Vertical mapping:
  - top of frame => higher pitch
  - bottom of frame => lower pitch
- Supports simultaneous notes from multiple tracked regions (polyphony cap).
- Controls for:
  - synth low rate
  - synth high rate
  - glide time
  - max voices
- Shared audio context for both knock + synth hooks.

### Capture + Export

- **Record video** from output canvas (`canvas.captureStream(30)`).
- Chooses best supported output mime type in this order:
  - `video/mp4;codecs=avc1.42E01E`
  - `video/mp4`
  - `video/quicktime`
  - `video/webm;codecs=vp9`
  - `video/webm`
- Auto-downloads recording when stopped (`.mp4`, `.mov`, or `.webm` based on browser support).
- Red recording border on canvas while recording (20% opacity style).
- **Capture photo** button:
  - JPEG quality `0.5` (50%)
  - 1.5s preview freeze overlay
  - then auto-downloads `.jpg`

### UI / Layout

- macOS terminal-inspired window chrome.
- Desktop layout aligns feed panel height to left control/status stack.
- Mobile breakpoint keeps single-column stack flow.

---

## Current Default Settings

- Mode: `datamosh`
- Pixel Inject: `0.00`
- Vector Push: `1.0`
- Keyframe Refresh Interval: `manual`
- Noise Reduction: `off`
- Tracker sensitivity: `14`
- Tracker max boxes: `12`
- Motion synth defaults:
  - low rate `0.6`
  - high rate `1.8`
  - glide `100 ms`
  - voices `4`

---

## Tech Stack

- **React 19**
- **TypeScript**
- **Vite**
- **Canvas 2D API**
- **WebRTC APIs** (`getUserMedia`, `enumerateDevices`)
- **Web Audio API** (sample playback and polyphonic voice routing)

---

## Project Structure

```text
src/
  App.tsx                         # UI, controls, capture/export, layout logic
  App.css                         # terminal-themed styles + responsive layout
  components/
    TerminalWindow.tsx            # reusable terminal-style panel shell
  hooks/
    useWebcamCanvas.ts            # camera stream, datamosh/tracker pipeline
    useKnockSound.ts              # knock sample loading + playback
    useMotionSynth.ts             # motion-driven polyphonic sample synth
    useSharedAudioContext.ts      # shared AudioContext lifecycle
public/
  sounds/
    knock.mp3
    heaven-synth-451981.mp3
```

---

## Local Development

### Requirements

- Node.js 20+ recommended
- Modern browser with webcam + WebAudio support

### Install

```bash
npm install
```

### Run (dev server)

```bash
npm run dev
```

### Lint

```bash
npm run lint
```

### Production build

```bash
npm run build
npm run preview
```

---

## Deployment Notes

- This app is frontend-only (no server required).
- Ensure `/public/sounds/*` assets are deployed.
- Webcam + audio behavior requires secure context on production (HTTPS).
- Public endpoint target: [https://curren.dev/mosher](https://curren.dev/mosher)

---

## Troubleshooting

- **No camera list / camera unavailable**  
  Check browser permission and OS privacy permissions.
- **No sound**  
  Interact with the page first (some browsers block autoplay until user gesture).
- **Motion synth shows loading**  
  Verify `public/sounds/heaven-synth-451981.mp3` exists and is reachable.
- **Performance drops**  
  Lower tracker box count, disable optional effects, or reduce camera resolution in OS/device settings.

---

## Privacy

- Camera frames are processed client-side in the browser.
- No backend upload pipeline is required by this app.

