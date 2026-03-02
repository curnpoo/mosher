import { useCallback, useEffect, useRef, useState } from 'react'
import type { MotionTrackFrame } from './useWebcamCanvas'
import { acquireSharedAudioContext, releaseSharedAudioContext } from './useSharedAudioContext'

type UseMotionSynthOptions = {
  enabled: boolean
  sampleUrl: string
  rateMin: number
  rateMax: number
  glideMs: number
  maxVoices: number
}

type MotionSynthResult = {
  soundLoaded: boolean
  updateTracks: (tracks: MotionTrackFrame[]) => void
  getCaptureStream: () => MediaStream | null
}

type Voice = {
  gain: GainNode
  stopTimeoutId: number | null
  grainTimerId: number | null
  nextGrainTime: number
  readHeadSec: number
  currentRate: number
  targetRate: number
}

const VOICE_LEVEL = 0.18
const ATTACK_S = 0.045
const RELEASE_S = 0.2
const GRAIN_HOP_S = 0.045
const GRAIN_DURATION_S = 0.135
const SCHEDULE_AHEAD_S = 0.12
const SCHEDULER_INTERVAL_MS = 25

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const toPlaybackRate = (normY: number, rateMin: number, rateMax: number) => {
  const y = Math.min(1, Math.max(0, normY))
  return rateMax - y * (rateMax - rateMin)
}

const wrapOffset = (offsetSec: number, durationSec: number) => {
  if (durationSec <= 0) return 0
  const wrapped = offsetSec % durationSec
  return wrapped < 0 ? wrapped + durationSec : wrapped
}

export function useMotionSynth({ enabled, sampleUrl, rateMin, rateMax, glideMs, maxVoices }: UseMotionSynthOptions): MotionSynthResult {
  const ctxRef = useRef<AudioContext | null>(null)
  const hasSharedContextRef = useRef(false)
  const bufferRef = useRef<AudioBuffer | null>(null)
  const outputRef = useRef<GainNode | null>(null)
  const captureDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const voicesRef = useRef<Map<number, Voice>>(new Map())
  const [soundLoaded, setSoundLoaded] = useState(false)

  const scheduleVoiceGrain = useCallback((voice: Voice, when: number) => {
    const ctx = ctxRef.current
    const buffer = bufferRef.current
    if (!ctx || !buffer || buffer.duration <= 0) return

    const smoothing = 0.35
    const nextRate = clamp(
      voice.currentRate + (voice.targetRate - voice.currentRate) * smoothing,
      0.2,
      4,
    )
    voice.currentRate = nextRate

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = nextRate

    const grainGain = ctx.createGain()
    grainGain.gain.setValueAtTime(0, when)
    grainGain.gain.linearRampToValueAtTime(1, when + GRAIN_DURATION_S * 0.36)
    grainGain.gain.linearRampToValueAtTime(0, when + GRAIN_DURATION_S)

    source.connect(grainGain)
    grainGain.connect(voice.gain)

    const offset = wrapOffset(voice.readHeadSec, buffer.duration)
    const grainBufferDuration = clamp(
      GRAIN_DURATION_S * nextRate,
      0.01,
      Math.max(0.01, buffer.duration - 0.001),
    )
    source.start(when, offset, grainBufferDuration)
    source.stop(when + GRAIN_DURATION_S + 0.03)
    source.onended = () => {
      source.disconnect()
      grainGain.disconnect()
    }

    voice.readHeadSec = wrapOffset(voice.readHeadSec + GRAIN_HOP_S, buffer.duration)
    voice.nextGrainTime += GRAIN_HOP_S
  }, [])

  const startVoiceScheduler = useCallback(
    (trackId: number, voice: Voice) => {
      if (voice.grainTimerId) {
        window.clearInterval(voice.grainTimerId)
      }

      voice.nextGrainTime = ctxRef.current?.currentTime ?? 0
      voice.grainTimerId = window.setInterval(() => {
        const ctx = ctxRef.current
        const latest = voicesRef.current.get(trackId)
        if (!ctx || !latest) return

        const scheduleUntil = ctx.currentTime + SCHEDULE_AHEAD_S
        while (latest.nextGrainTime < scheduleUntil) {
          scheduleVoiceGrain(latest, latest.nextGrainTime)
        }
      }, SCHEDULER_INTERVAL_MS)
    },
    [scheduleVoiceGrain],
  )

  const releaseVoice = useCallback((trackId: number, releaseTime = RELEASE_S) => {
    const ctx = ctxRef.current
    const voice = voicesRef.current.get(trackId)
    if (!ctx || !voice) return

    if (voice.stopTimeoutId) {
      window.clearTimeout(voice.stopTimeoutId)
      voice.stopTimeoutId = null
    }
    if (voice.grainTimerId) {
      window.clearInterval(voice.grainTimerId)
      voice.grainTimerId = null
    }

    const now = ctx.currentTime
    voice.gain.gain.cancelScheduledValues(now)
    voice.gain.gain.setTargetAtTime(0, now, releaseTime * 0.45)
    voice.stopTimeoutId = window.setTimeout(() => {
      voice.gain.disconnect()
      voicesRef.current.delete(trackId)
    }, Math.round((releaseTime + 0.08) * 1000))
  }, [])

  useEffect(() => {
    if (!enabled) {
      voicesRef.current.forEach((_, trackId) => releaseVoice(trackId, 0.08))
      return
    }

    let cancelled = false
    const voices = voicesRef.current

    const load = async () => {
      try {
        const ctx = acquireSharedAudioContext()
        hasSharedContextRef.current = true
        const response = await fetch(sampleUrl)
        const arrayBuffer = await response.arrayBuffer()
        const decoded = await ctx.decodeAudioData(arrayBuffer)
        if (cancelled) {
          if (hasSharedContextRef.current) {
            releaseSharedAudioContext()
            hasSharedContextRef.current = false
          }
          return
        }

        const output = ctx.createGain()
        output.gain.value = 1
        output.connect(ctx.destination)
        const captureDestination = ctx.createMediaStreamDestination()
        output.connect(captureDestination)

        ctxRef.current = ctx
        bufferRef.current = decoded
        outputRef.current = output
        captureDestinationRef.current = captureDestination
        setSoundLoaded(true)
      } catch (error) {
        console.error('[useMotionSynth] Failed to load sample:', error)
        setSoundLoaded(false)
      }
    }

    load().catch((error) => {
      console.error('[useMotionSynth]', error)
      setSoundLoaded(false)
    })

    return () => {
      cancelled = true
      voices.forEach((voice) => {
        if (voice.stopTimeoutId) {
          window.clearTimeout(voice.stopTimeoutId)
        }
        if (voice.grainTimerId) {
          window.clearInterval(voice.grainTimerId)
        }
        voice.gain.disconnect()
      })
      voices.clear()
      outputRef.current?.disconnect()
      outputRef.current = null
      captureDestinationRef.current = null
      bufferRef.current = null
      setSoundLoaded(false)
      if (hasSharedContextRef.current) {
        releaseSharedAudioContext()
        hasSharedContextRef.current = false
      }
      ctxRef.current = null
    }
  }, [enabled, releaseVoice, sampleUrl])

  const updateTracks = useCallback(
    (tracks: MotionTrackFrame[]) => {
      if (!enabled) return
      const ctx = ctxRef.current
      const buffer = bufferRef.current
      const output = outputRef.current
      if (!ctx || !buffer || !output) return

      if (ctx.state === 'suspended') {
        void ctx.resume()
      }

      const prioritized = [...tracks]
        .sort((a, b) => b.area - a.area)
        .slice(0, Math.max(1, Math.round(maxVoices)))
      const activeIds = new Set(prioritized.map((track) => track.id))
      const now = ctx.currentTime
      const safeRateMin = clamp(Math.min(rateMin, rateMax), 0.2, 4)
      const safeRateMax = clamp(Math.max(rateMin, rateMax), 0.2, 4)
      const glideS = clamp(glideMs, 20, 400) / 1000

      for (const track of prioritized) {
        const targetRate = toPlaybackRate(track.normY, safeRateMin, safeRateMax)
        let voice = voicesRef.current.get(track.id)

        if (!voice) {
          const gain = ctx.createGain()
          gain.gain.value = 0
          gain.connect(output)
          voice = {
            gain,
            stopTimeoutId: null,
            grainTimerId: null,
            nextGrainTime: now,
            readHeadSec: Math.random() * Math.max(buffer.duration, 0.001),
            currentRate: targetRate,
            targetRate,
          }
          voicesRef.current.set(track.id, voice)
          startVoiceScheduler(track.id, voice)
        }

        if (voice.stopTimeoutId) {
          window.clearTimeout(voice.stopTimeoutId)
          voice.stopTimeoutId = null
        }

        voice.targetRate = targetRate
        const rateBlend = clamp((SCHEDULER_INTERVAL_MS / 1000) / glideS, 0.06, 1)
        voice.currentRate += (voice.targetRate - voice.currentRate) * rateBlend

        voice.gain.gain.cancelScheduledValues(now)
        voice.gain.gain.setTargetAtTime(VOICE_LEVEL, now, ATTACK_S)
      }

      voicesRef.current.forEach((_, trackId) => {
        if (!activeIds.has(trackId)) {
          releaseVoice(trackId)
        }
      })
    },
    [enabled, glideMs, maxVoices, rateMax, rateMin, releaseVoice, startVoiceScheduler],
  )

  const getCaptureStream = useCallback(() => {
    return captureDestinationRef.current?.stream ?? null
  }, [])

  return { soundLoaded, updateTracks, getCaptureStream }
}
