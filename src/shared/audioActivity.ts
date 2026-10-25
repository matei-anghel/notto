export function computePcm16Rms(samples: Int16Array): number {
  if (!samples.length) return 0

  let sumSquares = 0
  for (let index = 0; index < samples.length; index += 1) {
    const normalized = samples[index] / 32768
    sumSquares += normalized * normalized
  }

  return Math.sqrt(sumSquares / samples.length)
}

export function hasAudiblePcm16Activity(samples: Int16Array, threshold = 0.02): boolean {
  return computePcm16Rms(samples) >= threshold
}

export function computeTimeDomainRms(samples: Uint8Array): number {
  if (!samples.length) return 0

  let sumSquares = 0
  for (let index = 0; index < samples.length; index += 1) {
    const normalized = (samples[index] - 128) / 128
    sumSquares += normalized * normalized
  }

  return Math.sqrt(sumSquares / samples.length)
}

export function hasAudibleTimeDomainActivity(samples: Uint8Array, threshold = 0.035): boolean {
  return computeTimeDomainRms(samples) >= threshold
}

export function shouldEmitAudioActivity(now: number, lastActivityAt: number, throttleMs = 1200): boolean {
  return now - lastActivityAt >= throttleMs
}
