let sharedAudioContext: AudioContext | null = null
let sharedUserCount = 0

export const acquireSharedAudioContext = () => {
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioContext()
  }
  sharedUserCount += 1
  return sharedAudioContext
}

export const releaseSharedAudioContext = () => {
  if (sharedUserCount > 0) {
    sharedUserCount -= 1
  }

  if (sharedUserCount === 0 && sharedAudioContext) {
    const ctx = sharedAudioContext
    sharedAudioContext = null
    void ctx.close()
  }
}
