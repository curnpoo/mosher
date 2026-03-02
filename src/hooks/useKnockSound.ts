import { useCallback, useEffect, useRef, useState } from 'react'
import { acquireSharedAudioContext, releaseSharedAudioContext } from './useSharedAudioContext'

const KNOCK_URL = '/sounds/knock.mp3'

// Silence-detection tuning
const WINDOW_MS = 20
const ONSET_THRESHOLD = 0.015
const SILENCE_RATIO = 0.35
const MIN_SEG_DURATION_S = 0.05
const SILENCE_WINDOWS = 6
const PAD_S = 0.03
const MAX_SEGMENTS = 4

type KnockSoundResult = {
  playKnock: () => void
  soundLoaded: boolean
}

function findKnockSegments(buffer: AudioBuffer): Array<[number, number]> {
  const data = buffer.getChannelData(0)
  const sampleRate = buffer.sampleRate
  const windowSize = Math.floor((sampleRate * WINDOW_MS) / 1000)
  const segments: Array<[number, number]> = []

  let inSound = false
  let segStart = 0
  let silenceCount = 0

  for (let i = 0; i < data.length; i += windowSize) {
    const end = Math.min(i + windowSize, data.length)
    let sum = 0
    for (let j = i; j < end; j++) {
      sum += data[j] * data[j]
    }
    const rms = Math.sqrt(sum / (end - i))

    if (!inSound && rms > ONSET_THRESHOLD) {
      inSound = true
      segStart = i / sampleRate
      silenceCount = 0
    } else if (inSound) {
      if (rms < ONSET_THRESHOLD * SILENCE_RATIO) {
        silenceCount++
        if (silenceCount >= SILENCE_WINDOWS) {
          inSound = false
          const segEnd = (i - silenceCount * windowSize) / sampleRate
          if (segEnd - segStart >= MIN_SEG_DURATION_S) {
            segments.push([
              Math.max(0, segStart - PAD_S),
              Math.min(buffer.duration, segEnd + PAD_S),
            ])
            if (segments.length >= MAX_SEGMENTS) break
          }
        }
      } else {
        silenceCount = 0
      }
    }
  }

  return segments
}

function sliceBuffer(ctx: AudioContext, src: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const startSample = Math.floor(startSec * src.sampleRate)
  const endSample = Math.min(Math.ceil(endSec * src.sampleRate), src.length)
  const length = Math.max(1, endSample - startSample)
  const out = ctx.createBuffer(src.numberOfChannels, length, src.sampleRate)
  for (let ch = 0; ch < src.numberOfChannels; ch++) {
    const srcData = src.getChannelData(ch)
    out.getChannelData(ch).set(srcData.subarray(startSample, endSample))
  }
  return out
}

export function useKnockSound(enabled: boolean): KnockSoundResult {
  const ctxRef = useRef<AudioContext | null>(null)
  const hasSharedContextRef = useRef(false)
  const buffersRef = useRef<AudioBuffer[]>([])
  const [soundLoaded, setSoundLoaded] = useState(false)

  useEffect(() => {
    if (!enabled) return

    let cancelled = false

    const load = async () => {
      try {
        const ctx = acquireSharedAudioContext()
        hasSharedContextRef.current = true
        ctxRef.current = ctx

        const response = await fetch(KNOCK_URL)
        const arrayBuffer = await response.arrayBuffer()
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer)

        if (cancelled) return

        const segments = findKnockSegments(audioBuffer)
        buffersRef.current = segments.map(([start, end]) => sliceBuffer(ctx, audioBuffer, start, end))
        setSoundLoaded(true)
      } catch (err) {
        console.error('[useKnockSound] Failed to load knock sounds:', err)
      }
    }

    load().catch((err) => {
      console.error('[useKnockSound]', err)
    })

    return () => {
      cancelled = true
      if (hasSharedContextRef.current) {
        releaseSharedAudioContext()
        hasSharedContextRef.current = false
      }
      ctxRef.current = null
      buffersRef.current = []
      setSoundLoaded(false)
    }
  }, [enabled])

  const playKnock = useCallback(() => {
    const ctx = ctxRef.current
    const buffers = buffersRef.current
    if (!ctx || buffers.length === 0) return

    const doPlay = () => {
      const buffer = buffers[Math.floor(Math.random() * buffers.length)]
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start()
    }

    if (ctx.state === 'suspended') {
      ctx.resume().then(doPlay).catch(() => {})
    } else {
      doPlay()
    }
  }, [])

  return { playKnock, soundLoaded }
}
