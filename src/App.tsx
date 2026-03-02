import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TerminalWindow } from './components/TerminalWindow'
import { useWebcamCanvas, type MotionTrackFrame, type MoshMode } from './hooks/useWebcamCanvas'
import { useKnockSound } from './hooks/useKnockSound'
import { useMotionSynth } from './hooks/useMotionSynth'
import './App.css'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const SPLASH_KEY = 'mosher_splash_seen_v1'
const MOBILE_BREAKPOINT_PX = 930

type CaptureMode = 'photo' | 'video'
type FacingPref = 'front' | 'back'

type CameraDevice = {
  id: string
  label: string
}

const isFrontLabel = (label: string) => /(front|facetime|user)/i.test(label)
const isBackLabel = (label: string) => /(back|rear|environment|world)/i.test(label)

const pickDeviceByFacing = (
  devices: CameraDevice[],
  preferredFacing: FacingPref,
  fallbackCurrentId: string,
) => {
  if (devices.length === 0) return ''

  const preferred = devices.find((device) =>
    preferredFacing === 'front' ? isFrontLabel(device.label) : isBackLabel(device.label),
  )
  if (preferred) {
    return preferred.id
  }

  const currentIdx = Math.max(
    0,
    devices.findIndex((device) => device.id === fallbackCurrentId),
  )
  const nextIdx = (currentIdx + 1) % devices.length
  return devices[nextIdx]?.id ?? devices[0].id
}

function App() {
  const [mode, setMode] = useState<MoshMode>('datamosh')
  const [captureMode, setCaptureMode] = useState<CaptureMode>('photo')
  const [modeTrayOpen, setModeTrayOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [facingPreference, setFacingPreference] = useState<FacingPref>('back')

  const [persistence, setPersistence] = useState(0)
  const [drift, setDrift] = useState(1)
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(0)
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [threshold, setThreshold] = useState(14)
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(true)
  const [maxTrackedBoxes, setMaxTrackedBoxes] = useState(12)
  const [noiseReduction, setNoiseReduction] = useState(false)
  const [moshPaused, setMoshPaused] = useState(false)

  const [knockSoundEnabled, setKnockSoundEnabled] = useState(false)
  const [motionSynthEnabled, setMotionSynthEnabled] = useState(true)
  const [motionSynthRateMin, setMotionSynthRateMin] = useState(0.6)
  const [motionSynthRateMax, setMotionSynthRateMax] = useState(1.8)
  const [motionSynthGlideMs, setMotionSynthGlideMs] = useState(100)
  const [motionSynthMaxVoices, setMotionSynthMaxVoices] = useState(4)

  const [isRecording, setIsRecording] = useState(false)
  const [isMobileLayout, setIsMobileLayout] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth <= MOBILE_BREAKPOINT_PX,
  )
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null)
  const [captureNotice, setCaptureNotice] = useState<string | null>(null)
  const [showSplash, setShowSplash] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(SPLASH_KEY) !== '1'
  })

  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const recordedChunksRef = useRef<BlobPart[]>([])
  const recordedMimeTypeRef = useRef('video/webm')
  const previewTimeoutRef = useRef<number | null>(null)
  const lastTouchTapRef = useRef(0)
  const captureNoticeTimeoutRef = useRef<number | null>(null)

  const { playKnock, soundLoaded } = useKnockSound(knockSoundEnabled)
  const { soundLoaded: motionSynthLoaded, updateTracks, getCaptureStream } = useMotionSynth({
    enabled: motionSynthEnabled && mode === 'channel',
    sampleUrl: '/sounds/heaven-synth-451981.mp3',
    rateMin: motionSynthRateMin,
    rateMax: motionSynthRateMax,
    glideMs: motionSynthGlideMs,
    maxVoices: motionSynthMaxVoices,
  })

  const handleTracksFrame = useCallback(
    (tracks: MotionTrackFrame[]) => {
      updateTracks(tracks)
    },
    [updateTracks],
  )

  useEffect(() => {
    const onResize = () => {
      setIsMobileLayout(window.innerWidth <= MOBILE_BREAKPOINT_PX)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    return () => {
      if (previewTimeoutRef.current) {
        window.clearTimeout(previewTimeoutRef.current)
      }
      if (captureNoticeTimeoutRef.current) {
        window.clearTimeout(captureNoticeTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (captureMode === 'photo' && isRecording) {
      recorderRef.current?.stop()
    }
  }, [captureMode, isRecording])

  const modeLabel = useMemo(() => (mode === 'datamosh' ? 'mosh' : 'motion synth'), [mode])
  const desktopModeLabel = useMemo(() => (mode === 'datamosh' ? 'datamosh' : 'motion-synth'), [mode])
  const refreshLabel = useMemo(
    () => (refreshIntervalMs === 0 ? 'manual' : `${(refreshIntervalMs / 1000).toFixed(1)}s`),
    [refreshIntervalMs],
  )
  const { canvasRef, videoRef, devices, error, status, fps, sourceResolution, processingResolution } = useWebcamCanvas({
    mode,
    enabled,
    selectedDeviceId,
    preferredFacing: facingPreference,
    mirrorVideo: facingPreference === 'front',
    persistence,
    drift,
    moshPaused,
    refreshIntervalMs,
    refreshTrigger,
    threshold,
    showBoundingBoxes,
    maxTrackedBoxes,
    noiseReduction,
    onNewBox: knockSoundEnabled ? playKnock : undefined,
    onTracksFrame: motionSynthEnabled && mode === 'channel' ? handleTracksFrame : undefined,
  })
  const resolvedSelectedDeviceId = useMemo(() => {
    if (devices.length === 0) return ''
    if (selectedDeviceId && devices.some((device) => device.id === selectedDeviceId)) {
      return selectedDeviceId
    }
    return pickDeviceByFacing(devices, facingPreference, selectedDeviceId)
  }, [devices, facingPreference, selectedDeviceId])

  useEffect(() => {
    if (!(motionSynthEnabled && mode === 'channel' && enabled && status === 'active')) {
      updateTracks([])
    }
  }, [enabled, mode, motionSynthEnabled, status, updateTracks])

  useEffect(() => {
    if (mode !== 'datamosh' || !enabled) {
      setMoshPaused(false)
    }
  }, [enabled, mode])
  const streamReady = status === 'active'

  const toggleCamera = () => {
    setEnabled((prev) => !prev)
  }

  const refreshKeyframeNow = () => {
    setRefreshTrigger((prev) => prev + 1)
  }

  const toggleMoshPause = () => {
    if (!moshPaused) {
      refreshKeyframeNow()
      setMoshPaused(true)
      return
    }
    setMoshPaused(false)
  }

  const dismissSplash = () => {
    setShowSplash(false)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SPLASH_KEY, '1')
    }
  }

  const switchCameraFacing = useCallback(() => {
    const nextFacing: FacingPref = facingPreference === 'back' ? 'front' : 'back'
    setFacingPreference(nextFacing)

    // On phones/tablets, letting getUserMedia use facingMode is more reliable than label matching.
    if (isMobileLayout) {
      setSelectedDeviceId('')
      return
    }

    if (devices.length < 2) {
      return
    }

    const nextId = pickDeviceByFacing(devices, nextFacing, selectedDeviceId)
    setSelectedDeviceId(nextId)
  }, [devices, facingPreference, isMobileLayout, selectedDeviceId])

  const handleDeviceSelection = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId)
      const selected = devices.find((device) => device.id === deviceId)
      if (!selected) {
        return
      }
      if (isFrontLabel(selected.label)) {
        setFacingPreference('front')
        return
      }
      if (isBackLabel(selected.label)) {
        setFacingPreference('back')
      }
    },
    [devices],
  )

  const handleStageTouchEnd = () => {
    const now = Date.now()
    if (now - lastTouchTapRef.current < 320) {
      switchCameraFacing()
    }
    lastTouchTapRef.current = now
  }

  const getPreferredRecordingMimeType = () => {
    const candidateTypes = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/quicktime',
      'video/webm;codecs=vp9',
      'video/webm',
    ]
    const recorderClass = globalThis.MediaRecorder
    if (!recorderClass || typeof recorderClass.isTypeSupported !== 'function') {
      return 'video/webm'
    }
    for (const type of candidateTypes) {
      if (recorderClass.isTypeSupported(type)) {
        return type
      }
    }
    return 'video/webm'
  }

  const getExtensionForMimeType = (mimeType: string) => {
    if (mimeType.includes('mp4')) return 'mp4'
    if (mimeType.includes('quicktime')) return 'mov'
    return 'webm'
  }

  const showCaptureNotice = useCallback((message: string) => {
    setCaptureNotice(message)
    if (captureNoticeTimeoutRef.current) {
      window.clearTimeout(captureNoticeTimeoutRef.current)
    }
    captureNoticeTimeoutRef.current = window.setTimeout(() => {
      setCaptureNotice(null)
      captureNoticeTimeoutRef.current = null
    }, 2600)
  }, [])

  const isLikelyIOS = () => {
    if (typeof navigator === 'undefined') return false
    const ua = navigator.userAgent
    const platform = navigator.platform
    return /iPad|iPhone|iPod/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  }

  const saveBlob = useCallback(
    async (blob: Blob, fileName: string, mimeType: string) => {
      const isMobile = isMobileLayout
      if (isMobile && typeof navigator !== 'undefined' && 'share' in navigator && 'File' in window) {
        try {
          const file = new File([blob], fileName, { type: mimeType })
          const canShareFiles =
            typeof navigator.canShare === 'function' ? navigator.canShare({ files: [file] }) : true
          if (canShareFiles) {
            await navigator.share({
              files: [file],
              title: fileName,
            })
            showCaptureNotice(isLikelyIOS() ? 'Saved via share sheet.' : 'Shared successfully.')
            return
          }
        } catch (shareError: any) {
          // Share canceled? Skip fallback and just show notice.
          console.debug('Share failed, falling back to download', shareError)
          if (shareError && (shareError.name === 'AbortError' || shareError.name === 'NotAllowedError')) {
            showCaptureNotice('Share cancelled.')
            return
          }
        }
      }

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      window.setTimeout(() => {
        URL.revokeObjectURL(url)
      }, 1500)

      if (isMobile && isLikelyIOS()) {
        showCaptureNotice('If prompted, tap Download, then Save Image/Video to Photos.')
      }
    },
    [isMobileLayout, showCaptureNotice],
  )

  const saveRecording = useCallback(async () => {
    if (recordedChunksRef.current.length === 0) return
    const mimeType = recordedMimeTypeRef.current
    const blob = new Blob(recordedChunksRef.current, { type: mimeType })
    const fileName = `mosh-recording-${Date.now()}.${getExtensionForMimeType(mimeType)}`
    await saveBlob(blob, fileName, mimeType)
    recordedChunksRef.current = []
    recordedMimeTypeRef.current = 'video/webm'
  }, [saveBlob])

  const stopRecorder = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
  }, [])

  const toggleRecording = () => {
    if (isRecording) {
      stopRecorder()
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    const canvasStream = canvas.captureStream(30)
    const stream = new MediaStream()
    canvasStream.getVideoTracks().forEach((track) => stream.addTrack(track))
    const synthCaptureStream = getCaptureStream()
    synthCaptureStream?.getAudioTracks().forEach((track) => stream.addTrack(track))
    recordedChunksRef.current = []

    try {
      const MediaRecorderClass = globalThis.MediaRecorder
      if (!MediaRecorderClass) {
        console.error('MediaRecorder is not available')
        return
      }
      const mimeType = getPreferredRecordingMimeType()
      const recorder = new MediaRecorderClass(stream, { mimeType })
      recordedMimeTypeRef.current = mimeType

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        setIsRecording(false)
        recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
        recordingStreamRef.current = null
        void saveRecording()
      }

      recorder.start()
      recorderRef.current = recorder
      recordingStreamRef.current = stream
      setIsRecording(true)
    } catch (recordingError) {
      console.error('MediaRecorder error', recordingError)
      stream.getTracks().forEach((track) => track.stop())
      recordingStreamRef.current = null
      setIsRecording(false)
    }
  }

  const capturePhoto = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dataUrl = canvas.toDataURL('image/jpeg', 0.88)
    const save = (blob: Blob | null) => {
      if (!blob) {
        return
      }
      void saveBlob(blob, `mosh-photo-${Date.now()}.jpg`, 'image/jpeg')
    }
    canvas.toBlob(save, 'image/jpeg', 0.88)

    if (previewTimeoutRef.current) {
      window.clearTimeout(previewTimeoutRef.current)
    }
    setPhotoPreviewUrl(dataUrl)
    previewTimeoutRef.current = window.setTimeout(() => {
      setPhotoPreviewUrl(null)
    }, 1600)
  }

  const triggerPrimaryCapture = () => {
    if (captureMode === 'video') {
      toggleRecording()
      return
    }
    capturePhoto()
  }

  useEffect(() => {
    return () => {
      stopRecorder()
    }
  }, [stopRecorder])

  const selectMode = (nextMode: MoshMode) => {
    setMode(nextMode)
    setModeTrayOpen(false)
  }

  if (!isMobileLayout) {
    return (
      <div className="app-shell">
        <video ref={videoRef} className="hidden-video" playsInline muted />

        <TerminalWindow title="mosher.feed" subtitle={streamReady ? './live/webcam.stream' : './live/no-signal'} className="window-main">
          <div className="canvas-group">
            <div className={`canvas-wrap ${isRecording ? 'is-recording' : ''}`}>
              <canvas ref={canvasRef} className="mosh-canvas" aria-label="Live webcam mosh canvas" />
              {photoPreviewUrl ? (
                <div className="photo-preview">
                  <img src={photoPreviewUrl} alt="Captured photo preview" />
                </div>
              ) : null}
              {mode === 'datamosh' ? (
                <button type="button" className="canvas-fab" onClick={toggleMoshPause}>
                  {moshPaused ? 'Resume' : 'Refresh'}
                </button>
              ) : null}
              {!streamReady ? (
                <div className="canvas-overlay">
                  <p className="prompt">$ awaiting camera stream...</p>
                  <p className="muted">Enable webcam to start realtime mosh processing.</p>
                </div>
              ) : null}
            </div>
            <div className="canvas-actions">
              <button type="button" className="terminal-button record-button" onClick={toggleRecording}>
                {isRecording ? 'Stop recording' : 'Record'}
              </button>
              <button type="button" className="terminal-button photo-button" onClick={capturePhoto} disabled={isRecording}>
                Capture photo
              </button>
            </div>
          </div>
        </TerminalWindow>

        <div className="left-stack">
          <TerminalWindow title="ctrl.panel" subtitle="./devices + ./modes" className="window-controls">
            <div className="control-stack">
              <label className="control-row" htmlFor="desktop-camera-select">
                <span className="prompt">$ camera</span>
                <select
                  id="desktop-camera-select"
                  className="terminal-input"
                  value={resolvedSelectedDeviceId}
                  onChange={(event) => handleDeviceSelection(event.target.value)}
                  disabled={devices.length === 0}
                >
                  {devices.length === 0 ? <option value="">No cameras detected</option> : null}
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="control-row control-row-inline">
                <span className="prompt">$ stream</span>
                <button type="button" className="terminal-button" onClick={toggleCamera}>
                  {enabled ? 'Disable camera' : 'Enable camera'}
                </button>
              </div>

              <div className="control-row">
                <span className="prompt">$ mode</span>
                <div className="mode-toggle" role="tablist" aria-label="Mosh mode selector">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'datamosh'}
                    className={`mode-button ${mode === 'datamosh' ? 'is-active' : ''}`}
                    onClick={() => setMode('datamosh')}
                  >
                    Datamosh
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'channel'}
                    className={`mode-button ${mode === 'channel' ? 'is-active' : ''}`}
                    onClick={() => setMode('channel')}
                  >
                    Motion Synth
                  </button>
                </div>
              </div>

              {mode === 'datamosh' ? (
                <>
                  <label className="control-row" htmlFor="desktop-persistence-range">
                    <span className="prompt">$ pixel inject: {persistence.toFixed(2)}</span>
                    <input
                      id="desktop-persistence-range"
                      type="range"
                      min={0}
                      max={0.4}
                      step={0.01}
                      value={persistence}
                      onChange={(event) => setPersistence(clamp(Number(event.target.value), 0, 0.4))}
                    />
                  </label>
                  <label className="control-row" htmlFor="desktop-drift-range">
                    <span className="prompt">$ vector push: {drift.toFixed(1)}</span>
                    <input
                      id="desktop-drift-range"
                      type="range"
                      min={1}
                      max={12}
                      step={0.5}
                      value={drift}
                      onChange={(event) => setDrift(clamp(Number(event.target.value), 1, 12))}
                    />
                  </label>
                  <label className="control-row" htmlFor="desktop-refresh-range">
                    <span className="prompt">$ keyframe refresh interval: {refreshLabel}</span>
                    <input
                      id="desktop-refresh-range"
                      type="range"
                      min={0}
                      max={4000}
                      step={250}
                      value={refreshIntervalMs}
                      onChange={(event) => setRefreshIntervalMs(clamp(Number(event.target.value), 0, 4000))}
                    />
                  </label>
                  <label className="control-row control-row-inline" htmlFor="desktop-noise-reduction-toggle">
                    <span className="prompt">$ noise reduction</span>
                    <input
                      id="desktop-noise-reduction-toggle"
                      type="checkbox"
                      checked={noiseReduction}
                      onChange={(event) => setNoiseReduction(event.target.checked)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <div className="control-row">
                    <button
                      type="button"
                      className={`terminal-button motion-synth-toggle ${motionSynthEnabled ? 'is-active' : ''}`}
                      onClick={() => setMotionSynthEnabled((prev) => !prev)}
                    >
                      {motionSynthEnabled
                        ? `Motion Synth On${!motionSynthLoaded ? ' (loading...)' : ''}`
                        : 'Motion Synth Off'}
                    </button>
                  </div>
                  <label className="control-row" htmlFor="desktop-threshold-range">
                    <span className="prompt">$ motion sensitivity: {threshold}</span>
                    <input
                      id="desktop-threshold-range"
                      type="range"
                      min={4}
                      max={20}
                      step={1}
                      value={threshold}
                      onChange={(event) => setThreshold(clamp(Number(event.target.value), 4, 20))}
                    />
                  </label>
                  <label className="control-row" htmlFor="desktop-max-tracked-range">
                    <span className="prompt">$ max tracked boxes: {maxTrackedBoxes}</span>
                    <input
                      id="desktop-max-tracked-range"
                      type="range"
                      min={3}
                      max={80}
                      step={1}
                      value={maxTrackedBoxes}
                      onChange={(event) => setMaxTrackedBoxes(clamp(Number(event.target.value), 3, 80))}
                    />
                  </label>
                  <label className="control-row control-row-inline" htmlFor="desktop-bbox-toggle">
                    <span className="prompt">$ show tracked boxes</span>
                    <input
                      id="desktop-bbox-toggle"
                      type="checkbox"
                      checked={showBoundingBoxes}
                      onChange={(event) => setShowBoundingBoxes(event.target.checked)}
                    />
                  </label>
                  <label className="control-row control-row-inline" htmlFor="desktop-knock-toggle">
                    <span className="prompt">$ knock sound{knockSoundEnabled && !soundLoaded ? ' (loading...)' : ''}</span>
                    <input
                      id="desktop-knock-toggle"
                      type="checkbox"
                      checked={knockSoundEnabled}
                      onChange={(event) => setKnockSoundEnabled(event.target.checked)}
                    />
                  </label>
                  <label className="control-row" htmlFor="desktop-motion-synth-rate-min-range">
                    <span className="prompt">$ synth low rate: {motionSynthRateMin.toFixed(2)}</span>
                    <input
                      id="desktop-motion-synth-rate-min-range"
                      type="range"
                      min={0.2}
                      max={3}
                      step={0.05}
                      value={motionSynthRateMin}
                      onChange={(event) => setMotionSynthRateMin(clamp(Number(event.target.value), 0.2, 3))}
                    />
                  </label>
                  <label className="control-row" htmlFor="desktop-motion-synth-rate-max-range">
                    <span className="prompt">$ synth high rate: {motionSynthRateMax.toFixed(2)}</span>
                    <input
                      id="desktop-motion-synth-rate-max-range"
                      type="range"
                      min={0.3}
                      max={4}
                      step={0.05}
                      value={motionSynthRateMax}
                      onChange={(event) => setMotionSynthRateMax(clamp(Number(event.target.value), 0.3, 4))}
                    />
                  </label>
                  <label className="control-row" htmlFor="desktop-motion-synth-glide-range">
                    <span className="prompt">$ synth glide ms: {motionSynthGlideMs}</span>
                    <input
                      id="desktop-motion-synth-glide-range"
                      type="range"
                      min={20}
                      max={400}
                      step={10}
                      value={motionSynthGlideMs}
                      onChange={(event) => setMotionSynthGlideMs(clamp(Number(event.target.value), 20, 400))}
                    />
                  </label>
                  <label className="control-row" htmlFor="desktop-motion-synth-max-voices-range">
                    <span className="prompt">$ synth voices: {motionSynthMaxVoices}</span>
                    <input
                      id="desktop-motion-synth-max-voices-range"
                      type="range"
                      min={1}
                      max={8}
                      step={1}
                      value={motionSynthMaxVoices}
                      onChange={(event) => setMotionSynthMaxVoices(clamp(Number(event.target.value), 1, 8))}
                    />
                  </label>
                </>
              )}
            </div>
          </TerminalWindow>
        </div>

        <div className="right-stack">
          <TerminalWindow title="notes.txt" subtitle="./help/quickstart" className="window-info">
            <ul className="tips-list">
              <li>$ Video is mirrored to match expected webcam behavior.</li>
              <li>$ Refresh captures a new keyframe and freezes the mosh.</li>
              <li>$ Resume continues moshing from the frozen frame.</li>
              <li>$ Tracker mode keeps the live feed normal while layering colorful multi-box trails.</li>
            </ul>
          </TerminalWindow>

          <TerminalWindow title="status.log" subtitle="./runtime/stats" className="window-status">
            <div className="status-lines">
              <p>
                <span className="prompt">$ mosher &gt; mode</span> <strong>{desktopModeLabel}</strong>
              </p>
              <p>
                <span className="prompt">$ fps</span> {fps.toFixed(1)}
              </p>
              <p>
                <span className="prompt">$ source res</span>{' '}
                {sourceResolution.width > 0 && sourceResolution.height > 0
                  ? `${sourceResolution.width}x${sourceResolution.height}`
                  : '--'}
              </p>
              <p>
                <span className="prompt">$ process res</span>{' '}
                {processingResolution.width > 0 && processingResolution.height > 0
                  ? `${processingResolution.width}x${processingResolution.height}`
                  : '--'}
              </p>
              <p>
                <span className="prompt">$ state</span> {status}
              </p>
              {error ? <p className="error-line">! {error}</p> : null}
            </div>
          </TerminalWindow>
        </div>
      </div>
    )
  }

  return (
    <div className="camera-app">
      <video ref={videoRef} className="hidden-video" playsInline muted />

      <div className="mobile-titlebar">
        <div className="mobile-statusline">
          <span>Signal</span>
          <span>{enabled ? 'Live' : 'Idle'}</span>
        </div>
        <h1>MOSH</h1>
        <p>curren.dev</p>
      </div>

      <div
        className="camera-stage"
        onDoubleClick={switchCameraFacing}
        onTouchEnd={handleStageTouchEnd}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            switchCameraFacing()
          }
        }}
      >
        <canvas ref={canvasRef} className="camera-canvas" aria-label="Live webcam mosh canvas" />

        {!streamReady ? (
          <div className="camera-overlay">
            <p className="camera-overlay-title">$ awaiting camera stream...</p>
            <p className="camera-overlay-subtitle">Enable camera to start realtime mosh processing.</p>
          </div>
        ) : null}

        {photoPreviewUrl ? (
          <div className="photo-preview">
            <img src={photoPreviewUrl} alt="Captured photo preview" />
          </div>
        ) : null}

        <div className="mobile-top-controls">
          <button type="button" className="chip-button" onClick={toggleCamera}>
            {enabled ? 'On' : 'Off'}
          </button>
          <button type="button" className="chip-button" onClick={() => setNoiseReduction((prev) => !prev)}>
            NR {noiseReduction ? 'On' : 'Off'}
          </button>
        </div>

        <div className={`mode-tray ${modeTrayOpen ? 'is-open' : ''}`}>
          <button
            type="button"
            className={`mode-pill ${mode === 'datamosh' ? 'is-active' : ''}`}
            onClick={() => selectMode('datamosh')}
          >
            Mosh
          </button>
          <button
            type="button"
            className={`mode-pill ${mode === 'channel' ? 'is-active' : ''}`}
            onClick={() => selectMode('channel')}
          >
            Motion Synth
          </button>
        </div>

        <div className="bottom-hud">
          <button
            type="button"
            className={`mode-selector ${modeTrayOpen ? 'is-open' : ''}`}
            onClick={() => {
              setModeTrayOpen((prev) => !prev)
              setSettingsOpen(false)
            }}
          >
            {modeLabel}
          </button>

          <div className="control-dock">
            <button
              type="button"
              className={`dock-icon-button ${captureMode === 'photo' ? 'is-active' : ''}`}
              onClick={() => setCaptureMode('photo')}
            >
              Photo
            </button>
            <button
              type="button"
              className={`dock-icon-button ${captureMode === 'video' ? 'is-active' : ''}`}
              onClick={() => setCaptureMode('video')}
            >
              Video
            </button>

            <button
              type="button"
              className={`shutter-button ${captureMode === 'video' ? 'video' : 'photo'} ${
                isRecording ? 'is-recording' : ''
              }`}
              onClick={triggerPrimaryCapture}
            >
              {captureMode === 'video' ? (isRecording ? 'Stop' : 'Rec') : 'Snap'}
            </button>

            <button type="button" className="dock-icon-button" onClick={switchCameraFacing}>
              Flip
            </button>
            <button
              type="button"
              className="dock-icon-button"
              onClick={() => {
                setSettingsOpen((prev) => !prev)
                setModeTrayOpen(false)
              }}
            >
              Settings
            </button>
          </div>

          {mode === 'datamosh' ? (
            <button type="button" className="refresh-fab" onClick={toggleMoshPause}>
              {moshPaused ? 'Resume' : 'Refresh'}
            </button>
          ) : null}
        </div>

        {captureNotice ? <div className="capture-toast">{captureNotice}</div> : null}

        {settingsOpen ? (
          <div className={`settings-sheet ${settingsOpen ? 'is-open' : ''}`}>
            <div className="settings-header">
              <p>$ settings</p>
              <button type="button" className="hud-button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>

            <div className="settings-body">
              <label className="setting-row" htmlFor="camera-select">
                <span>$ camera</span>
                <select
                  id="camera-select"
                  value={resolvedSelectedDeviceId}
                  onChange={(event) => handleDeviceSelection(event.target.value)}
                  disabled={devices.length === 0}
                >
                  {devices.length === 0 ? <option value="">No cameras detected</option> : null}
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>

              {mode === 'datamosh' ? (
                <>
                  <label className="setting-row" htmlFor="persistence-range">
                    <span>$ pixel inject: {persistence.toFixed(2)}</span>
                    <input
                      id="persistence-range"
                      className="mobile-range"
                      type="range"
                      min={0}
                      max={0.4}
                      step={0.01}
                      value={persistence}
                      onChange={(event) => setPersistence(clamp(Number(event.target.value), 0, 0.4))}
                    />
                  </label>
                  <label className="setting-row" htmlFor="drift-range">
                    <span>$ vector push: {drift.toFixed(1)}</span>
                    <input
                      id="drift-range"
                      className="mobile-range"
                      type="range"
                      min={1}
                      max={12}
                      step={0.5}
                      value={drift}
                      onChange={(event) => setDrift(clamp(Number(event.target.value), 1, 12))}
                    />
                  </label>
                  <label className="setting-row" htmlFor="refresh-interval-range">
                    <span>$ keyframe refresh interval: {refreshIntervalMs === 0 ? 'manual' : `${(
                      refreshIntervalMs / 1000
                    ).toFixed(1)}s`}</span>
                    <input
                      id="refresh-interval-range"
                      className="mobile-range"
                      type="range"
                      min={0}
                      max={4000}
                      step={250}
                      value={refreshIntervalMs}
                      onChange={(event) => setRefreshIntervalMs(clamp(Number(event.target.value), 0, 4000))}
                    />
                  </label>
                  <label className="setting-row-inline" htmlFor="noise-reduction-toggle">
                    <span>$ noise reduction</span>
                    <input
                      id="noise-reduction-toggle"
                      type="checkbox"
                      checked={noiseReduction}
                      onChange={(event) => setNoiseReduction(event.target.checked)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="setting-row" htmlFor="threshold-range">
                    <span>$ motion sensitivity: {threshold}</span>
                    <input
                      id="threshold-range"
                      className="mobile-range"
                      type="range"
                      min={4}
                      max={20}
                      step={1}
                      value={threshold}
                      onChange={(event) => setThreshold(clamp(Number(event.target.value), 4, 20))}
                    />
                  </label>
                  <label className="setting-row" htmlFor="max-tracked-range">
                    <span>$ max tracked boxes: {maxTrackedBoxes}</span>
                    <input
                      id="max-tracked-range"
                      className="mobile-range"
                      type="range"
                      min={3}
                      max={80}
                      step={1}
                      value={maxTrackedBoxes}
                      onChange={(event) => setMaxTrackedBoxes(clamp(Number(event.target.value), 3, 80))}
                    />
                  </label>
                  <label className="setting-row-inline" htmlFor="bbox-toggle">
                    <span>$ show tracked boxes</span>
                    <input
                      id="bbox-toggle"
                      type="checkbox"
                      checked={showBoundingBoxes}
                      onChange={(event) => setShowBoundingBoxes(event.target.checked)}
                    />
                  </label>
                  <label className="setting-row-inline" htmlFor="knock-sound-toggle">
                    <span>$ knock sound{knockSoundEnabled && !soundLoaded ? ' (loading...)' : ''}</span>
                    <input
                      id="knock-sound-toggle"
                      type="checkbox"
                      checked={knockSoundEnabled}
                      onChange={(event) => setKnockSoundEnabled(event.target.checked)}
                    />
                  </label>
                  <label className="setting-row-inline" htmlFor="motion-synth-toggle">
                    <span>$ motion synth{motionSynthEnabled && !motionSynthLoaded ? ' (loading...)' : ''}</span>
                    <input
                      id="motion-synth-toggle"
                      type="checkbox"
                      checked={motionSynthEnabled}
                      onChange={(event) => setMotionSynthEnabled(event.target.checked)}
                    />
                  </label>
                  <label className="setting-row" htmlFor="motion-synth-rate-min-range">
                    <span>$ synth low rate: {motionSynthRateMin.toFixed(2)}</span>
                    <input
                      id="motion-synth-rate-min-range"
                      className="mobile-range"
                      type="range"
                      min={0.2}
                      max={3}
                      step={0.05}
                      value={motionSynthRateMin}
                      onChange={(event) => setMotionSynthRateMin(clamp(Number(event.target.value), 0.2, 3))}
                    />
                  </label>
                  <label className="setting-row" htmlFor="motion-synth-rate-max-range">
                    <span>$ synth high rate: {motionSynthRateMax.toFixed(2)}</span>
                    <input
                      id="motion-synth-rate-max-range"
                      className="mobile-range"
                      type="range"
                      min={0.3}
                      max={4}
                      step={0.05}
                      value={motionSynthRateMax}
                      onChange={(event) => setMotionSynthRateMax(clamp(Number(event.target.value), 0.3, 4))}
                    />
                  </label>
                  <label className="setting-row" htmlFor="motion-synth-glide-range">
                    <span>$ synth glide ms: {motionSynthGlideMs}</span>
                    <input
                      id="motion-synth-glide-range"
                      className="mobile-range"
                      type="range"
                      min={20}
                      max={400}
                      step={10}
                      value={motionSynthGlideMs}
                      onChange={(event) => setMotionSynthGlideMs(clamp(Number(event.target.value), 20, 400))}
                    />
                  </label>
                  <label className="setting-row" htmlFor="motion-synth-max-voices-range">
                    <span>$ synth voices: {motionSynthMaxVoices}</span>
                    <input
                      id="motion-synth-max-voices-range"
                      className="mobile-range"
                      type="range"
                      min={1}
                      max={8}
                      step={1}
                      value={motionSynthMaxVoices}
                      onChange={(event) => setMotionSynthMaxVoices(clamp(Number(event.target.value), 1, 8))}
                    />
                  </label>
                </>
              )}

              <div className="status-block">
                <p>$ mode: {modeLabel}</p>
                <p>$ fps: {fps.toFixed(1)}</p>
                <p>
                  $ source: {sourceResolution.width > 0 && sourceResolution.height > 0
                    ? `${sourceResolution.width}x${sourceResolution.height}`
                    : '--'}
                </p>
                <p>
                  $ process: {processingResolution.width > 0 && processingResolution.height > 0
                    ? `${processingResolution.width}x${processingResolution.height}`
                    : '--'}
                </p>
                <p>$ state: {status}</p>
                {error ? <p className="error-line">! {error}</p> : null}
              </div>
            </div>
          </div>
        ) : null}

        {showSplash ? (
          <div className="splash-overlay">
            <div className="splash-card">
              <h1>Mosher Camera</h1>
              <p>Use the bottom controls like a camera app: Photo/Video, flip camera, and settings.</p>
              <p>Double-tap the preview to switch between front and back cameras quickly.</p>
              <button type="button" className="splash-button" onClick={dismissSplash}>
                Start Camera
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default App
