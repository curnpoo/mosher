import { useEffect, useRef, useState, type RefObject } from 'react'

export type MoshMode = 'datamosh' | 'channel'
export type MotionTrackFrame = {
  id: number
  normY: number
  area: number
  misses: number
}

type UseWebcamCanvasOptions = {
  mode: MoshMode
  enabled: boolean
  selectedDeviceId: string
  preferredFacing?: 'front' | 'back'
  mirrorVideo?: boolean
  persistence: number
  drift: number
  refreshIntervalMs: number
  refreshTrigger: number
  threshold: number
  showBoundingBoxes: boolean
  maxTrackedBoxes: number
  noiseReduction: boolean
  onNewBox?: () => void
  onTracksFrame?: (tracks: MotionTrackFrame[]) => void
}

type VideoInputDevice = {
  id: string
  label: string
}

type WebcamStatus = 'idle' | 'requesting' | 'active' | 'error'

type UseWebcamCanvasResult = {
  canvasRef: RefObject<HTMLCanvasElement | null>
  videoRef: RefObject<HTMLVideoElement | null>
  devices: VideoInputDevice[]
  error: string | null
  status: WebcamStatus
  fps: number
  sourceResolution: { width: number; height: number }
  processingResolution: { width: number; height: number }
}

type TrackBox = {
  x: number
  y: number
  width: number
  height: number
  area: number
}

type TrailPoint = {
  x: number
  y: number
  age: number
}

type TrackedBox = {
  id: number
  hue: number
  x: number
  y: number
  width: number
  height: number
  area: number
  misses: number
  trail: TrailPoint[]
}

const REQUEST_IDEAL_WIDTH = 1920
const REQUEST_IDEAL_HEIGHT = 1080
const REQUEST_IDEAL_ASPECT = 16 / 9
const DEFAULT_PROCESSING_PIXELS = 640 * 360
const MIN_PROCESSING_PIXELS = 240 * 135
const MAX_PROCESSING_PIXELS = 960 * 540
const MIN_PROCESSING_WIDTH = 160
const MIN_PROCESSING_HEIGHT = 90
const EDGE_SAMPLE_INSET = 2
const OUT_OF_BOUNDS_SAD_PENALTY = 420
const RESOLUTION_ADJUST_INTERVAL_MS = 1100
const ADAPTIVE_FPS_UP_THRESHOLD = 52
const ADAPTIVE_FPS_DOWN_THRESHOLD = 34
const ADAPTIVE_UPSCALE_FACTOR = 1.2
const ADAPTIVE_DOWNSCALE_FACTOR = 0.8
const ADAPTIVE_WARMUP_MS = 2200
const MIN_BLOB_AREA_FLOOR = 180
const MIN_BLOB_AREA_RATIO = 0.003
const MIN_BLOB_EDGE = 12
const BLOB_MERGE_PADDING = 10

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const isFrontFacingLabel = (label: string) => /(front|facetime|user)/i.test(label)
const isBackFacingLabel = (label: string) => /(back|rear|environment|world)/i.test(label)

const getProcessingSize = (width: number, height: number, maxProcessingPixels: number) => {
  const scale = Math.min(1, Math.sqrt(maxProcessingPixels / Math.max(1, width * height)))
  const scaledWidth = Math.round(width * scale)
  const scaledHeight = Math.round(height * scale)
  const procWidth = clamp(scaledWidth, MIN_PROCESSING_WIDTH, width)
  const procHeight = clamp(scaledHeight, MIN_PROCESSING_HEIGHT, height)
  return { width: procWidth, height: procHeight }
}

const resizePixelBuffer = (
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Uint8ClampedArray => {
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4)
  for (let y = 0; y < targetHeight; y += 1) {
    const sy = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / targetHeight))
    for (let x = 0; x < targetWidth; x += 1) {
      const sx = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / targetWidth))
      const sourceIdx = (sy * sourceWidth + sx) * 4
      const targetIdx = (y * targetWidth + x) * 4
      output[targetIdx] = source[sourceIdx]
      output[targetIdx + 1] = source[sourceIdx + 1]
      output[targetIdx + 2] = source[sourceIdx + 2]
      output[targetIdx + 3] = source[sourceIdx + 3]
    }
  }
  return output
}

const applyBoxBlur = (source: Uint8ClampedArray, width: number, height: number) => {
  const output = new Uint8ClampedArray(source.length)
  const radius = 1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let count = 0

      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy
        if (ny < 0 || ny >= height) {
          continue
        }

        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx
          if (nx < 0 || nx >= width) {
            continue
          }

          const idx = (ny * width + nx) * 4
          r += source[idx]
          g += source[idx + 1]
          b += source[idx + 2]
          count += 1
        }
      }

      const dest = (y * width + x) * 4
      output[dest] = Math.round(r / count)
      output[dest + 1] = Math.round(g / count)
      output[dest + 2] = Math.round(b / count)
      output[dest + 3] = 255
    }
  }

  return output
}

const blockSad = (
  curr: Uint8ClampedArray,
  prev: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  blockSize: number,
  dx: number,
  dy: number,
): number => {
  let sad = 0
  for (let by = 0; by < blockSize; by += 2) {
    const py = y + by
    const qy = py + dy
    if (py >= height || qy < EDGE_SAMPLE_INSET || qy >= height - EDGE_SAMPLE_INSET) {
      sad += OUT_OF_BOUNDS_SAD_PENALTY
      continue
    }

    for (let bx = 0; bx < blockSize; bx += 2) {
      const px = x + bx
      const qx = px + dx
      if (px >= width || qx < EDGE_SAMPLE_INSET || qx >= width - EDGE_SAMPLE_INSET) {
        sad += OUT_OF_BOUNDS_SAD_PENALTY
        continue
      }

      const i = (py * width + px) * 4
      const j = (qy * width + qx) * 4

      sad += Math.abs(curr[i] - prev[j])
      sad += Math.abs(curr[i + 1] - prev[j + 1])
      sad += Math.abs(curr[i + 2] - prev[j + 2])
    }
  }

  return sad
}

const applyDatamoshVectors = (
  curr: Uint8ClampedArray,
  prev: Uint8ClampedArray,
  mosh: Uint8ClampedArray,
  out: Uint8ClampedArray,
  width: number,
  height: number,
  persistence: number,
  drift: number,
): void => {
  const blockSize = 8
  const search = Math.round(clamp(drift * 2.5, 4, 24))
  const push = 1 + clamp(drift * 0.18, 0, 2.5)
  const sampleInsetX = Math.min(EDGE_SAMPLE_INSET, Math.floor((width - 1) / 2))
  const sampleInsetY = Math.min(EDGE_SAMPLE_INSET, Math.floor((height - 1) / 2))
  const sampleMinX = sampleInsetX
  const sampleMaxX = width - 1 - sampleInsetX
  const sampleMinY = sampleInsetY
  const sampleMaxY = height - 1 - sampleInsetY

  for (let y = 0; y < height; y += blockSize) {
    for (let x = 0; x < width; x += blockSize) {
      let bestDx = 0
      let bestDy = 0
      let bestScore = Number.POSITIVE_INFINITY

      for (let dy = -search; dy <= search; dy += 1) {
        for (let dx = -search; dx <= search; dx += 1) {
          const score = blockSad(curr, prev, width, height, x, y, blockSize, dx, dy)
          if (score < bestScore) {
            bestScore = score
            bestDx = dx
            bestDy = dy
          }
        }
      }

      const sourceX = Math.round(x + bestDx * push)
      const sourceY = Math.round(y + bestDy * push)

      for (let by = 0; by < blockSize; by += 1) {
        const ty = y + by
        if (ty >= height) {
          continue
        }

        for (let bx = 0; bx < blockSize; bx += 1) {
          const tx = x + bx
          if (tx >= width) {
            continue
          }

          const sx = sourceX + bx
          const sy = sourceY + by

          const outIdx = (ty * width + tx) * 4
          if (sx < sampleMinX || sx > sampleMaxX || sy < sampleMinY || sy > sampleMaxY) {
            out[outIdx] = curr[outIdx]
            out[outIdx + 1] = curr[outIdx + 1]
            out[outIdx + 2] = curr[outIdx + 2]
          } else {
            const srcIdx = (sy * width + sx) * 4
            out[outIdx] = mosh[srcIdx]
            out[outIdx + 1] = mosh[srcIdx + 1]
            out[outIdx + 2] = mosh[srcIdx + 2]
          }
          out[outIdx + 3] = 255
        }
      }
    }
  }

  const keep = 1 - clamp(persistence, 0, 0.4)
  const inject = 1 - keep

  for (let i = 0; i < out.length; i += 4) {
    out[i] = (out[i] * keep + curr[i] * inject) | 0
    out[i + 1] = (out[i + 1] * keep + curr[i + 1] * inject) | 0
    out[i + 2] = (out[i + 2] * keep + curr[i + 2] * inject) | 0
  }
}

const findMotionBlobs = (
  curr: Uint8ClampedArray,
  prev: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
  maxResults: number,
  minBlobArea: number,
): TrackBox[] => {
  const motionThreshold = Math.round(clamp(threshold, 4, 60))
  const mask = new Uint8Array(width * height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const dr = Math.abs(curr[i] - prev[i])
      const dg = Math.abs(curr[i + 1] - prev[i + 1])
      const db = Math.abs(curr[i + 2] - prev[i + 2])
      const delta = dr * 0.2126 + dg * 0.7152 + db * 0.0722
      if (delta >= motionThreshold) {
        mask[y * width + x] = 1
      }
    }
  }

  const visited = new Uint8Array(width * height)
  const blobs: TrackBox[] = []

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x
      if (mask[idx] === 0 || visited[idx] === 1) {
        continue
      }

      let minX = x
      let minY = y
      let maxX = x
      let maxY = y
      let area = 0

      const queue: number[] = [idx]
      visited[idx] = 1

      for (let q = 0; q < queue.length; q += 1) {
        const current = queue[q]
        const cx = current % width
        const cy = Math.floor(current / width)
        area += 1

        minX = Math.min(minX, cx)
        minY = Math.min(minY, cy)
        maxX = Math.max(maxX, cx)
        maxY = Math.max(maxY, cy)

        const neighbors = [current - 1, current + 1, current - width, current + width]

        for (const n of neighbors) {
          if (n < 0 || n >= width * height) {
            continue
          }
          const nx = n % width
          const ny = Math.floor(n / width)
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) {
            continue
          }
          if (mask[n] === 0 || visited[n] === 1) {
            continue
          }
          visited[n] = 1
          queue.push(n)
        }
      }

      const boxWidth = maxX - minX + 1
      const boxHeight = maxY - minY + 1
      if (area >= minBlobArea && boxWidth >= MIN_BLOB_EDGE && boxHeight >= MIN_BLOB_EDGE) {
        blobs.push({
          x: minX,
          y: minY,
          width: boxWidth,
          height: boxHeight,
          area,
        })
      }
    }
  }

  const nearOrOverlapping = (a: TrackBox, b: TrackBox) =>
    a.x <= b.x + b.width + BLOB_MERGE_PADDING &&
    a.x + a.width + BLOB_MERGE_PADDING >= b.x &&
    a.y <= b.y + b.height + BLOB_MERGE_PADDING &&
    a.y + a.height + BLOB_MERGE_PADDING >= b.y

  const mergeBoxes = (a: TrackBox, b: TrackBox): TrackBox => {
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const maxX = Math.max(a.x + a.width, b.x + b.width)
    const maxY = Math.max(a.y + a.height, b.y + b.height)
    return {
      x,
      y,
      width: maxX - x,
      height: maxY - y,
      area: a.area + b.area,
    }
  }

  const merged = [...blobs]
  let didMerge = true
  while (didMerge) {
    didMerge = false
    outer: for (let i = 0; i < merged.length; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        if (!nearOrOverlapping(merged[i], merged[j])) {
          continue
        }
        merged[i] = mergeBoxes(merged[i], merged[j])
        merged.splice(j, 1)
        didMerge = true
        break outer
      }
    }
  }

  return merged.sort((a, b) => b.area - a.area).slice(0, Math.max(1, maxResults))
}

const centerOf = (box: Pick<TrackBox, 'x' | 'y' | 'width' | 'height'>) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
})

const assignHue = (id: number) => (id * 137.508) % 360

const updateTrackedBoxes = (
  current: TrackedBox[],
  candidates: TrackBox[],
  maxTrackedBoxes: number,
  nextTrackIdRef: { current: number },
): TrackedBox[] => {
  const unmatched = new Set(candidates.map((_, idx) => idx))
  const updated: TrackedBox[] = []

  for (const track of current) {
    const c0 = centerOf(track)
    let bestIdx = -1
    let bestDistance = Number.POSITIVE_INFINITY

    for (const idx of unmatched) {
      const candidate = candidates[idx]
      const c1 = centerOf(candidate)
      const distance = Math.hypot(c1.x - c0.x, c1.y - c0.y)
      if (distance < bestDistance) {
        bestDistance = distance
        bestIdx = idx
      }
    }

    if (bestIdx >= 0 && bestDistance < 80) {
      unmatched.delete(bestIdx)
      const next = candidates[bestIdx]
      const blend = 0.52
      const cx = c0.x * blend + centerOf(next).x * (1 - blend)
      const cy = c0.y * blend + centerOf(next).y * (1 - blend)
      const trail = [...track.trail, { x: cx, y: cy, age: 0 }].slice(-22)
      updated.push({
        ...track,
        x: track.x * blend + next.x * (1 - blend),
        y: track.y * blend + next.y * (1 - blend),
        width: track.width * blend + next.width * (1 - blend),
        height: track.height * blend + next.height * (1 - blend),
        area: next.area,
        misses: 0,
        trail,
      })
      continue
    }

    if (track.misses < 10) {
      updated.push({
        ...track,
        misses: track.misses + 1,
        trail: track.trail.map((point) => ({ ...point, age: point.age + 1 })).slice(-18),
      })
    }
  }

  for (const idx of unmatched) {
    if (updated.length >= maxTrackedBoxes) {
      break
    }
    const candidate = candidates[idx]
    const id = nextTrackIdRef.current
    nextTrackIdRef.current += 1
    const center = centerOf(candidate)

    updated.push({
      id,
      hue: assignHue(id),
      x: candidate.x,
      y: candidate.y,
      width: candidate.width,
      height: candidate.height,
      area: candidate.area,
      misses: 0,
      trail: [{ x: center.x, y: center.y, age: 0 }],
    })
  }

  return updated.slice(0, maxTrackedBoxes)
}

const drawTrackingOverlay = (
  ctx: CanvasRenderingContext2D,
  tracks: TrackedBox[],
  scaleX: number,
  scaleY: number,
  timestamp: number,
) => {
  for (const track of tracks) {
    const alpha = clamp(1 - track.misses * 0.12, 0.2, 1)
    const stroke = `hsla(${track.hue}, 92%, 62%, ${alpha})`
    const glow = `hsla(${(track.hue + 40) % 360}, 100%, 68%, ${alpha * 0.45})`
    const x = track.x * scaleX
    const y = track.y * scaleY
    const width = track.width * scaleX
    const height = track.height * scaleY

    if (track.trail.length > 1) {
      ctx.save()
      ctx.lineCap = 'round'
      for (let i = 1; i < track.trail.length; i += 1) {
        const a = track.trail[i - 1]
        const b = track.trail[i]
        const fade = i / track.trail.length
        ctx.strokeStyle = `hsla(${(track.hue + i * 4) % 360}, 95%, 64%, ${fade * alpha * 0.8})`
        ctx.lineWidth = 1 + fade * 3
        ctx.beginPath()
        ctx.moveTo(a.x * scaleX, a.y * scaleY)
        ctx.lineTo(b.x * scaleX, b.y * scaleY)
        ctx.stroke()
      }
      ctx.restore()
    }

    const pulse = 0.88 + 0.12 * Math.sin(timestamp * 0.008 + track.id)
    const glowGradient = ctx.createRadialGradient(
      x + width / 2,
      y + height / 2,
      Math.min(width, height) * 0.15,
      x + width / 2,
      y + height / 2,
      Math.max(width, height) * 0.9,
    )
    glowGradient.addColorStop(0, `hsla(${track.hue}, 96%, 66%, ${0.24 * alpha})`)
    glowGradient.addColorStop(1, 'hsla(0, 0%, 0%, 0)')

    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    ctx.fillStyle = glowGradient
    ctx.fillRect(x - width * 0.45, y - height * 0.45, width * 1.9, height * 1.9)
    ctx.restore()

    ctx.save()
    ctx.strokeStyle = stroke
    ctx.shadowColor = glow
    ctx.shadowBlur = 14
    ctx.lineWidth = 1.5 + pulse * 2.2
    ctx.setLineDash([12, 5])
    ctx.lineDashOffset = -(timestamp * 0.045 + track.id * 3.2)
    ctx.strokeRect(x, y, width, height)
    ctx.restore()
  }
}

export function useWebcamCanvas({
  mode,
  enabled,
  selectedDeviceId,
  preferredFacing = 'front',
  mirrorVideo = true,
  persistence,
  drift,
  refreshIntervalMs,
  refreshTrigger,
  threshold,
  showBoundingBoxes,
  maxTrackedBoxes,
  noiseReduction,
  onNewBox,
  onTracksFrame,
}: UseWebcamCanvasOptions): UseWebcamCanvasResult {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const prevFrameRef = useRef<Uint8ClampedArray | null>(null)
  const moshFrameRef = useRef<Uint8ClampedArray | null>(null)
  const moshOutBufRef = useRef<Uint8ClampedArray | null>(null)
  const moshImageDataRef = useRef<ImageData | null>(null)
  const bufSizeRef = useRef(0)
  const frameCounterRef = useRef(0)
  const trackRef = useRef<TrackedBox[]>([])
  const nextTrackIdRef = useRef(1)
  const lastRefreshTimeRef = useRef(0)
  const lastRefreshTriggerRef = useRef(0)
  const onNewBoxRef = useRef(onNewBox)
  const onTracksFrameRef = useRef(onTracksFrame)
  const mirrorVideoRef = useRef(mirrorVideo)
  useEffect(() => {
    onNewBoxRef.current = onNewBox
  }, [onNewBox])
  useEffect(() => {
    onTracksFrameRef.current = onTracksFrame
  }, [onTracksFrame])
  useEffect(() => {
    mirrorVideoRef.current = mirrorVideo
  }, [mirrorVideo])

  const [devices, setDevices] = useState<VideoInputDevice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<WebcamStatus>('idle')
  const [fps, setFps] = useState(0)
  const [sourceResolution, setSourceResolution] = useState({ width: 0, height: 0 })
  const [processingResolution, setProcessingResolution] = useState({ width: 0, height: 0 })

  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef<number | null>(null)
  const previousTickRef = useRef<number>(0)
  const lastFpsUpdateRef = useRef<number>(0)
  const adaptivePixelsRef = useRef<number>(DEFAULT_PROCESSING_PIXELS)
  const fpsEmaRef = useRef<number>(60)
  const lastResolutionAdjustRef = useRef<number>(0)
  const adaptiveStartTimeRef = useRef<number>(0)
  const processingSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 })

  useEffect(() => {
    const enumerate = async () => {
      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices()
        const cameraDevices = allDevices
          .filter((device) => device.kind === 'videoinput')
          .map((device, idx) => ({
            id: device.deviceId,
            label: device.label || `Camera ${idx + 1}`,
          }))
        setDevices(cameraDevices)
      } catch (deviceError) {
        console.error(deviceError)
        setError('Unable to enumerate camera devices.')
      }
    }

    enumerate().catch((deviceError) => {
      console.error(deviceError)
      setError('Unable to enumerate camera devices.')
    })

    const handleDeviceChange = () => {
      enumerate().catch((deviceError) => {
        console.error(deviceError)
      })
    }

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange)
    }
  }, [])

  useEffect(() => {
    const videoElement = videoRef.current

    if (!enabled) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }

      if (videoElement) {
        videoElement.srcObject = null
      }

      prevFrameRef.current = null
      moshFrameRef.current = null
      moshOutBufRef.current = null
      moshImageDataRef.current = null
      bufSizeRef.current = 0
      trackRef.current = []
      nextTrackIdRef.current = 1
      frameCounterRef.current = 0
      lastRefreshTimeRef.current = 0
      lastRefreshTriggerRef.current = 0
      adaptivePixelsRef.current = DEFAULT_PROCESSING_PIXELS
      fpsEmaRef.current = 60
      lastResolutionAdjustRef.current = 0
      adaptiveStartTimeRef.current = 0
      processingSizeRef.current = { width: 0, height: 0 }
      return
    }

    let cancelled = false

    const startStream = async () => {
      setStatus('requesting')
      setError(null)

      try {
        const baseVideoConstraints = {
          width: { ideal: REQUEST_IDEAL_WIDTH },
          height: { ideal: REQUEST_IDEAL_HEIGHT },
          aspectRatio: { ideal: REQUEST_IDEAL_ASPECT },
        }
        const facingMode = preferredFacing === 'back' ? 'environment' : 'user'
        const constraints: MediaStreamConstraints = {
          video: selectedDeviceId
            ? {
                deviceId: { exact: selectedDeviceId },
                ...baseVideoConstraints,
              }
            : {
                ...baseVideoConstraints,
                facingMode: { ideal: facingMode },
              },
          audio: false,
        }

        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop())
        }

        streamRef.current = stream
        const activeTrack = stream.getVideoTracks()[0]
        const detectedFacingMode = activeTrack?.getSettings?.().facingMode
        const trackLabel = activeTrack?.label ?? ''
        if (detectedFacingMode === 'user' || (!detectedFacingMode && isFrontFacingLabel(trackLabel))) {
          mirrorVideoRef.current = true
        } else if (
          detectedFacingMode === 'environment' ||
          detectedFacingMode === 'rear' ||
          (!detectedFacingMode && isBackFacingLabel(trackLabel))
        ) {
          mirrorVideoRef.current = false
        } else {
          // Keep caller preference when track does not expose reliable facing metadata.
          mirrorVideoRef.current = mirrorVideo
        }
        const video = videoElement
        if (!video) {
          return
        }

        video.srcObject = stream
        await video.play()

        const refreshedDevices = await navigator.mediaDevices.enumerateDevices()
        const cameraDevices = refreshedDevices
          .filter((device) => device.kind === 'videoinput')
          .map((device, idx) => ({
            id: device.deviceId,
            label: device.label || `Camera ${idx + 1}`,
          }))
        setDevices(cameraDevices)
        setStatus('active')
      } catch (streamError) {
        console.error(streamError)
        setStatus('error')
        setError('Camera access failed. Check browser permissions and try again.')
      }
    }

    startStream().catch((streamError) => {
      console.error(streamError)
      setStatus('error')
      setError('Camera access failed. Check browser permissions and try again.')
    })

    return () => {
      cancelled = true
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }
      if (videoElement) {
        videoElement.srcObject = null
      }
    }
  }, [enabled, mirrorVideo, preferredFacing, selectedDeviceId])

  useEffect(() => {
    if (!enabled || status !== 'active') {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      return
    }

    if (!captureCanvasRef.current) {
      captureCanvasRef.current = document.createElement('canvas')
    }

    const canvas = canvasRef.current
    const video = videoRef.current
    const captureCanvas = captureCanvasRef.current
    if (!canvas || !video || !captureCanvas) {
      return
    }

    const ctx = canvas.getContext('2d', { alpha: false })
    const capCtx = captureCanvas.getContext('2d', { willReadFrequently: true })
    if (!ctx || !capCtx) {
      return
    }

    previousTickRef.current = performance.now()
    lastFpsUpdateRef.current = performance.now()
    fpsEmaRef.current = 60
    lastResolutionAdjustRef.current = 0
    adaptiveStartTimeRef.current = 0

    const render = (timestamp: number) => {
      const width = video.videoWidth
      const height = video.videoHeight
      if (!width || !height) {
        frameRef.current = requestAnimationFrame(render)
        return
      }
      setSourceResolution((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }

      const processingSize = getProcessingSize(width, height, adaptivePixelsRef.current)
      const procWidth = processingSize.width
      const procHeight = processingSize.height
      setProcessingResolution((prev) =>
        prev.width === procWidth && prev.height === procHeight ? prev : { width: procWidth, height: procHeight },
      )
      if (captureCanvas.width !== procWidth || captureCanvas.height !== procHeight) {
        captureCanvas.width = procWidth
        captureCanvas.height = procHeight
      }

      capCtx.save()
      capCtx.clearRect(0, 0, procWidth, procHeight)
      if (mirrorVideoRef.current) {
        capCtx.scale(-1, 1)
        capCtx.drawImage(video, -procWidth, 0, procWidth, procHeight)
      } else {
        capCtx.drawImage(video, 0, 0, procWidth, procHeight)
      }
      capCtx.restore()

      const pixelCount = procWidth * procHeight * 4
      if (bufSizeRef.current !== pixelCount) {
        const previousSize = processingSizeRef.current
        const hadPreviousBuffers =
          previousSize.width > 0 &&
          previousSize.height > 0 &&
          prevFrameRef.current !== null &&
          moshFrameRef.current !== null

        if (hadPreviousBuffers) {
          prevFrameRef.current = resizePixelBuffer(
            prevFrameRef.current!,
            previousSize.width,
            previousSize.height,
            procWidth,
            procHeight,
          )
          moshFrameRef.current = resizePixelBuffer(
            moshFrameRef.current!,
            previousSize.width,
            previousSize.height,
            procWidth,
            procHeight,
          )
          moshOutBufRef.current = new Uint8ClampedArray(moshFrameRef.current)
        } else {
          prevFrameRef.current = new Uint8ClampedArray(pixelCount)
          moshFrameRef.current = new Uint8ClampedArray(pixelCount)
          moshOutBufRef.current = new Uint8ClampedArray(pixelCount)
          frameCounterRef.current = 0
          lastRefreshTimeRef.current = 0
        }

        moshImageDataRef.current = new ImageData(procWidth, procHeight)
        bufSizeRef.current = pixelCount
        processingSizeRef.current = { width: procWidth, height: procHeight }
      }

      const currImage = capCtx.getImageData(0, 0, procWidth, procHeight)
      const currData = currImage.data
      const prevData = prevFrameRef.current!
      const workingCurrData = noiseReduction && mode === 'datamosh' ? applyBoxBlur(currData, procWidth, procHeight) : currData

      if (mode === 'datamosh') {
        const manualRefresh = refreshTrigger !== lastRefreshTriggerRef.current
        if (manualRefresh) {
          lastRefreshTriggerRef.current = refreshTrigger
        }

        const intervalRefresh =
          refreshIntervalMs > 0 &&
          timestamp - lastRefreshTimeRef.current >= refreshIntervalMs &&
          frameCounterRef.current > 0
        const shouldResetKeyframe = frameCounterRef.current === 0 || manualRefresh || intervalRefresh

        if (shouldResetKeyframe) {
          moshFrameRef.current!.set(currData)
          lastRefreshTimeRef.current = timestamp
        } else {
          applyDatamoshVectors(
            workingCurrData,
            prevData,
            moshFrameRef.current!,
            moshOutBufRef.current!,
            procWidth,
            procHeight,
            persistence,
            drift,
          )
          // swap: out becomes new mosh buffer
          const tmp = moshFrameRef.current!
          moshFrameRef.current = moshOutBufRef.current
          moshOutBufRef.current = tmp
        }

        const output = moshImageDataRef.current
        if (output) {
          output.data.set(moshFrameRef.current!)
          capCtx.putImageData(output, 0, 0)
        }

        ctx.imageSmoothingEnabled = true
        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(captureCanvas, 0, 0, width, height)
        onTracksFrameRef.current?.([])
      } else {
        ctx.imageSmoothingEnabled = true
        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(captureCanvas, 0, 0, width, height)

        if (showBoundingBoxes && frameCounterRef.current > 0) {
          const minBlobArea = Math.max(
            MIN_BLOB_AREA_FLOOR,
            Math.round(procWidth * procHeight * MIN_BLOB_AREA_RATIO),
          )
          const boxes = findMotionBlobs(
            currData,
            prevData,
            procWidth,
            procHeight,
            threshold,
            maxTrackedBoxes,
            minBlobArea,
          )
          const prevIds = new Set(trackRef.current.map((t) => t.id))
          trackRef.current = updateTrackedBoxes(
            trackRef.current,
            boxes,
            clamp(maxTrackedBoxes, 3, 80),
            nextTrackIdRef,
          )
          if (onNewBoxRef.current) {
            for (const track of trackRef.current) {
              if (!prevIds.has(track.id)) {
                onNewBoxRef.current()
              }
            }
          }
          onTracksFrameRef.current?.(
            trackRef.current.map((track) => ({
              id: track.id,
              normY: clamp((track.y + track.height * 0.5) / procHeight, 0, 1),
              area: track.area,
              misses: track.misses,
            })),
          )
          const sx = width / procWidth
          const sy = height / procHeight
          drawTrackingOverlay(ctx, trackRef.current, sx, sy, timestamp)
        } else {
          trackRef.current = []
          onTracksFrameRef.current?.([])
        }
      }

      prevData.set(workingCurrData)
      frameCounterRef.current += 1

      const delta = Math.max(1, timestamp - previousTickRef.current)
      previousTickRef.current = timestamp
      const instantFps = 1000 / delta
      fpsEmaRef.current = fpsEmaRef.current * 0.88 + instantFps * 0.12

      if (timestamp - lastResolutionAdjustRef.current >= RESOLUTION_ADJUST_INTERVAL_MS) {
        if (adaptiveStartTimeRef.current === 0) {
          adaptiveStartTimeRef.current = timestamp
        }
        const inWarmup = timestamp - adaptiveStartTimeRef.current <= ADAPTIVE_WARMUP_MS
        if (inWarmup) {
          let nextPixels = adaptivePixelsRef.current
          if (fpsEmaRef.current < ADAPTIVE_FPS_DOWN_THRESHOLD) {
            nextPixels = Math.round(nextPixels * ADAPTIVE_DOWNSCALE_FACTOR)
          } else if (fpsEmaRef.current > ADAPTIVE_FPS_UP_THRESHOLD) {
            nextPixels = Math.round(nextPixels * ADAPTIVE_UPSCALE_FACTOR)
          }

          adaptivePixelsRef.current = clamp(nextPixels, MIN_PROCESSING_PIXELS, MAX_PROCESSING_PIXELS)
        }
        lastResolutionAdjustRef.current = timestamp
      }

      if (timestamp - lastFpsUpdateRef.current > 220) {
        setFps((prev) => prev * 0.4 + instantFps * 0.6)
        lastFpsUpdateRef.current = timestamp
      }

      frameRef.current = requestAnimationFrame(render)
    }

    frameRef.current = requestAnimationFrame(render)

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [
    mode,
    enabled,
    status,
    persistence,
    drift,
    refreshIntervalMs,
    refreshTrigger,
    threshold,
    showBoundingBoxes,
    maxTrackedBoxes,
    noiseReduction,
    mirrorVideo,
  ])

  return {
    canvasRef,
    videoRef,
    devices,
    error: enabled ? error : null,
    status: enabled ? status : 'idle',
    fps: enabled && Number.isFinite(fps) ? fps : 0,
    sourceResolution: enabled ? sourceResolution : { width: 0, height: 0 },
    processingResolution: enabled ? processingResolution : { width: 0, height: 0 },
  }
}
