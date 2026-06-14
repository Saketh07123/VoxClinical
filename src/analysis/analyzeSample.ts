import type { AddSampleInput, ModelResult, RiskLevel, Sample } from '../types'
import type { AudioFeatures } from './audioFeatures'
import { extractAudioFeatures, getAudioDuration } from './audioFeatures'
import { extractTextFeatures, getAnalysisText } from './textFeatures'

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function riskFromScore(score: number): RiskLevel {
  if (score < 35) return 'low'
  if (score < 65) return 'moderate'
  return 'elevated'
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function round0(n: number): number {
  return Math.round(n)
}

function computeConfidence(opts: {
  wordCount: number
  durationSeconds?: number
  hasTranscript: boolean
  type: Sample['type']
}): number {
  let score = 0
  if (opts.wordCount >= 50) score += 45
  else if (opts.wordCount >= 20) score += 25
  else if (opts.wordCount > 0) score += 10

  if (opts.type === 'speech') {
    if (opts.durationSeconds && opts.durationSeconds >= 30) score += 30
    else if (opts.durationSeconds && opts.durationSeconds >= 10) score += 15
    if (opts.hasTranscript) score += 25
  } else {
    score += 55
  }

  return clamp(score, 0, 100)
}

// ── Parkinson's Disease (ParkVox-v1) ─────────────────────────────────────────
// Acoustic: speech rate, pause frequency, avg pause duration, prosody variation
// Linguistic: lexical richness, avg sentence length, content word ratio

function buildParkinsonResult(
  audioFeatures: AudioFeatures | null,
  text: string | null,
  wordCount: number,
  durationSeconds: number | undefined,
  sampleType: Sample['type'],
): ModelResult {
  const markers: import("../types").LinguisticMarker[] = []

  if (audioFeatures) {
    if (durationSeconds && durationSeconds > 0 && wordCount > 0) {
      markers.push({
        id: 'speech-rate',
        label: 'Speech rate',
        value: round0((wordCount / durationSeconds) * 60),
        unit: 'wpm',
        description: 'Words per minute — reduced rate and irregularity are hallmarks of hypokinetic dysarthria in PD',
      })
    }
    markers.push(
      {
        id: 'pause-freq',
        label: 'Pause frequency',
        value: audioFeatures.pauseFrequencyPerMinute,
        unit: '/min',
        description: 'Silent segments ≥250ms per minute detected from audio amplitude',
      },
      {
        id: 'avg-pause',
        label: 'Avg pause duration',
        value: audioFeatures.avgPauseDurationMs,
        unit: 'ms',
        description: 'Mean length of detected silent pauses',
      },
      {
        id: 'prosody',
        label: 'Prosody variation',
        value: audioFeatures.prosodyVariation,
        unit: '%',
        description: 'RMS energy variation — monotone speech is a key PD acoustic marker',
      },
    )
  }

  if (text && text.trim().length >= 20) {
    const f = extractTextFeatures(text)
    markers.push(
      {
        id: 'lexical-richness',
        label: 'Lexical richness',
        value: round0(f.typeTokenRatio * 100),
        unit: '%',
        description: 'Type-token ratio — vocabulary breadth; reduced in PD-related language changes',
      },
      {
        id: 'sentence-length',
        label: 'Avg sentence length',
        value: round1(f.avgWordsPerSentence),
        unit: 'words',
        description: 'Mean words per sentence — syntactic simplification leads to shorter sentences in PD',
      },
      {
        id: 'content-ratio',
        label: 'Content word ratio',
        value: round0(f.contentWordRatio),
        unit: '%',
        description: 'Share of content (non-function) words — reduced ratio reflects lexical access difficulties',
      },
    )
  }

  if (markers.length === 0) {
    return {
      modelName: 'ParkVox-v1',
      condition: "Parkinson's",
      riskScore: null,
      riskLevel: null,
      confidence: null,
      markers: [],
      summary: 'Insufficient data. Provide audio or at least 20 characters of text for PD analysis.',
    }
  }

  let riskScore = 0
  let factors = 0

  const m = (id: string) => markers.find((x) => x.id === id)

  const sr = m('speech-rate')
  if (sr) {
    const r = sr.value
    if (r < 100) riskScore += clamp(((100 - r) / 50) * 100, 0, 100)
    else if (r > 180) riskScore += clamp(((r - 180) / 60) * 100, 0, 100)
    factors++
  }
  const pf = m('pause-freq'); if (pf) { riskScore += clamp((pf.value / 10) * 100, 0, 100); factors++ }
  const pr = m('prosody'); if (pr) { riskScore += clamp(100 - pr.value, 0, 100); factors++ }
  const lr = m('lexical-richness'); if (lr) { riskScore += clamp(100 - lr.value, 0, 100); factors++ }
  const sl = m('sentence-length'); if (sl) { riskScore += clamp(((10 - Math.min(sl.value, 10)) / 10) * 100, 0, 100); factors++ }
  const cr = m('content-ratio'); if (cr) { riskScore += clamp(100 - cr.value, 0, 100); factors++ }

  const composite = round0(riskScore / factors)
  const confidence = computeConfidence({ wordCount, durationSeconds, hasTranscript: wordCount > 0, type: sampleType })

  let summary = 'Acoustic and linguistic markers computed from the submitted sample.'
  if (composite >= 65) summary = 'Markers suggest elevated acoustic and linguistic changes associated with PD.'
  else if (composite >= 35) summary = 'Some markers fall outside typical ranges.'
  else summary = 'Markers are within typical ranges for the extracted features.'

  return {
    modelName: 'ParkVox-v1',
    condition: "Parkinson's",
    riskScore: composite,
    riskLevel: riskFromScore(composite),
    confidence,
    markers,
    summary,
  }
}

// ── Dementia (CognVox-v1) ─────────────────────────────────────────────────────
// Acoustic: speech rate, avg pause duration, pause frequency, prosody variation
// Linguistic: semantic coherence, lexical diversity, idea density, pronoun ratio

function buildDementiaResult(
  audioFeatures: AudioFeatures | null,
  text: string | null,
  wordCount: number,
  durationSeconds: number | undefined,
  sampleType: Sample['type'],
): ModelResult {
  const markers: import("../types").LinguisticMarker[] = []

  if (audioFeatures) {
    if (durationSeconds && durationSeconds > 0 && wordCount > 0) {
      markers.push({
        id: 'speech-rate',
        label: 'Speech rate',
        value: round0((wordCount / durationSeconds) * 60),
        unit: 'wpm',
        description: 'Words per minute — progressive slowing is common in dementia-related speech',
      })
    }
    markers.push(
      {
        id: 'avg-pause',
        label: 'Avg pause duration',
        value: audioFeatures.avgPauseDurationMs,
        unit: 'ms',
        description: 'Mean pause length — prolonged pauses reflect word-finding difficulty in dementia',
      },
      {
        id: 'pause-freq',
        label: 'Pause frequency',
        value: audioFeatures.pauseFrequencyPerMinute,
        unit: '/min',
        description: 'Silent segments ≥250ms per minute detected from audio amplitude',
      },
      {
        id: 'prosody',
        label: 'Prosody variation',
        value: audioFeatures.prosodyVariation,
        unit: '%',
        description: 'Energy variation across the recording — reduced variation is associated with dementia',
      },
    )
  }

  if (text && text.trim().length >= 20) {
    const f = extractTextFeatures(text)
    markers.push(
      {
        id: 'coherence',
        label: 'Semantic coherence',
        value: f.coherenceScore,
        unit: '%',
        description: 'Keyword overlap between consecutive sentences — reduced in dementia-related language changes',
      },
      {
        id: 'lexical-div',
        label: 'Lexical diversity',
        value: round0(f.typeTokenRatio * 100),
        unit: '%',
        description: 'Type-token ratio (unique words ÷ total words)',
      },
      {
        id: 'idea-density',
        label: 'Idea density',
        value: round1(f.ideaDensity),
        unit: 'words/sent',
        description: 'Content words per sentence — reduced in dementia-related language changes',
      },
      {
        id: 'pronoun-ratio',
        label: 'Pronoun ratio',
        value: round1(f.pronounRatio),
        unit: '%',
        description: 'Pronouns as a share of total words — elevated ratio is associated with reduced lexical access',
      },
    )
  }

  if (markers.length === 0) {
    return {
      modelName: 'CognVox-v1',
      condition: 'Dementia',
      riskScore: null,
      riskLevel: null,
      confidence: null,
      markers: [],
      summary: 'Insufficient data. Provide audio or at least 20 characters of text for dementia analysis.',
    }
  }

  let riskScore = 0
  let factors = 0

  const m = (id: string) => markers.find((x) => x.id === id)

  const sr = m('speech-rate'); if (sr) { riskScore += sr.value < 90 ? clamp(((90 - sr.value) / 60) * 100, 0, 100) : 0; factors++ }
  const ap = m('avg-pause'); if (ap) { riskScore += clamp((ap.value / 800) * 100, 0, 100); factors++ }
  const pf = m('pause-freq'); if (pf) { riskScore += clamp((pf.value / 12) * 100, 0, 100); factors++ }
  const pr = m('prosody'); if (pr) { riskScore += clamp(100 - pr.value, 0, 100); factors++ }
  const co = m('coherence'); if (co) { riskScore += clamp(100 - co.value, 0, 100) * 0.35; factors += 0.35 }
  const ld = m('lexical-div'); if (ld) { riskScore += clamp(100 - ld.value, 0, 100) * 0.25; factors += 0.25 }
  const id_ = m('idea-density'); if (id_) { riskScore += clamp((id_.value < 4 ? (4 - id_.value) / 4 : 0) * 100, 0, 100) * 0.2; factors += 0.2 }
  const por = m('pronoun-ratio'); if (por) { riskScore += clamp((por.value / 25) * 100, 0, 100) * 0.2; factors += 0.2 }

  const composite = round0(riskScore / factors)
  const confidence = computeConfidence({ wordCount, durationSeconds, hasTranscript: wordCount > 0, type: sampleType })

  let summary = 'Acoustic and linguistic markers computed from the submitted sample.'
  if (composite >= 65) summary = 'Markers suggest elevated cognitive and speech changes associated with dementia.'
  else if (composite >= 35) summary = 'Some markers fall outside typical ranges.'
  else summary = 'Markers are within typical ranges for the extracted features.'

  return {
    modelName: 'CognVox-v1',
    condition: 'Dementia',
    riskScore: composite,
    riskLevel: riskFromScore(composite),
    confidence,
    markers,
    summary,
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function analyzeSample(input: AddSampleInput): Promise<{
  durationSeconds?: number
  transcript?: string
  results: NonNullable<Sample['results']>
}> {
  const analysisText = getAnalysisText(input)

  let audioFeatures: AudioFeatures | null = null
  let durationSeconds: number | undefined

  if (input.audioBlob) {
    audioFeatures = await extractAudioFeatures(input.audioBlob)
    durationSeconds = audioFeatures.durationSeconds
  }

  const textFeatures = analysisText ? extractTextFeatures(analysisText) : null
  const wordCount = textFeatures?.wordCount ?? 0
  const speechAudio = input.type === 'speech' ? audioFeatures : null

  const parkinson = buildParkinsonResult(speechAudio, analysisText, wordCount, durationSeconds, input.type)
  const dementia = buildDementiaResult(speechAudio, analysisText, wordCount, durationSeconds, input.type)

  if (parkinson.riskScore === null && dementia.riskScore === null) {
    throw new Error(
      input.type === 'speech'
        ? 'Could not analyze sample. Provide audio with a transcript, or at least 20 characters of transcript text.'
        : 'Could not analyze sample. Text must be at least 20 characters.',
    )
  }

  return {
    durationSeconds,
    transcript: input.transcript,
    results: { parkinson, dementia },
  }
}

export async function getDurationFromBlob(blob: Blob): Promise<number> {
  return getAudioDuration(blob)
}
