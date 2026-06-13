import type { AddSampleInput, ModelResult, RiskLevel, Sample } from '../types'
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

function buildParkinsonResult(
  audioFeatures: Awaited<ReturnType<typeof extractAudioFeatures>> | null,
  wordCount: number,
  durationSeconds: number | undefined,
): ModelResult {
  const markers = []

  if (durationSeconds && durationSeconds > 0 && wordCount > 0) {
    const speechRate = round0((wordCount / durationSeconds) * 60)
    markers.push({
      id: 'speech-rate',
      label: 'Speech rate',
      value: speechRate,
      unit: 'wpm',
      description: 'Words per minute (transcript word count ÷ duration)',
    })
  }

  if (audioFeatures) {
    markers.push(
      {
        id: 'pause-freq',
        label: 'Pause frequency',
        value: audioFeatures.pauseFrequencyPerMinute,
        unit: '/min',
        description: 'Silent segments ≥250ms detected from audio amplitude',
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
        description: 'RMS energy variation across the recording',
      },
    )
  }

  if (markers.length === 0) {
    return {
      modelName: 'ParkSpeech-v2',
      condition: "Parkinson's",
      riskScore: null,
      riskLevel: null,
      confidence: null,
      markers: [],
      summary: 'Insufficient speech data. Provide audio and a transcript for acoustic analysis.',
    }
  }

  const speechRateMarker = markers.find((m) => m.id === 'speech-rate')
  const pauseMarker = markers.find((m) => m.id === 'pause-freq')
  const prosodyMarker = markers.find((m) => m.id === 'prosody')

  let riskScore = 0
  let factors = 0

  if (speechRateMarker) {
    const rate = speechRateMarker.value
    if (rate < 100) riskScore += clamp(((100 - rate) / 50) * 100, 0, 100)
    else if (rate > 180) riskScore += clamp(((rate - 180) / 60) * 100, 0, 100)
    factors++
  }

  if (pauseMarker) {
    riskScore += clamp((pauseMarker.value / 10) * 100, 0, 100)
    factors++
  }

  if (prosodyMarker) {
    riskScore += clamp(100 - prosodyMarker.value, 0, 100)
    factors++
  }

  const composite = factors > 0 ? round0(riskScore / factors) : null
  const confidence = computeConfidence({
    wordCount,
    durationSeconds,
    hasTranscript: wordCount > 0,
    type: 'speech',
  })

  let summary = 'Acoustic markers computed from the submitted recording.'
  if (composite !== null) {
    if (composite >= 65) summary = 'Acoustic markers show elevated pause frequency or reduced prosody variation.'
    else if (composite >= 35) summary = 'Some acoustic markers fall outside typical ranges.'
    else summary = 'Acoustic markers are within typical ranges for the extracted features.'
  }

  return {
    modelName: 'ParkSpeech-v2',
    condition: "Parkinson's",
    riskScore: composite,
    riskLevel: composite !== null ? riskFromScore(composite) : null,
    confidence: composite !== null ? confidence : null,
    markers,
    summary,
  }
}

function buildAlsResult(text: string | null): ModelResult {
  if (!text || text.trim().length < 20) {
    return {
      modelName: 'ALS-Lex-v1',
      condition: 'ALS',
      riskScore: null,
      riskLevel: null,
      confidence: null,
      markers: [],
      summary: 'Insufficient text. Provide at least 20 characters of transcript or text content.',
    }
  }

  const features = extractTextFeatures(text)
  const lexicalDiversity = round0(features.typeTokenRatio * 100)
  const pronounRatio = round1(features.pronounRatio)
  const coherence = features.coherenceScore
  const ideaDensity = round1(features.ideaDensity)

  const markers = [
    {
      id: 'coherence',
      label: 'Semantic coherence',
      value: coherence,
      unit: '%',
      description: 'Keyword overlap between consecutive sentences',
    },
    {
      id: 'lexical-div',
      label: 'Lexical diversity',
      value: lexicalDiversity,
      unit: '%',
      description: 'Type-token ratio (unique words ÷ total words)',
    },
    {
      id: 'idea-density',
      label: 'Idea density',
      value: ideaDensity,
      unit: 'words/sent',
      description: 'Content words per sentence',
    },
    {
      id: 'pronoun-ratio',
      label: 'Pronoun ratio',
      value: pronounRatio,
      unit: '%',
      description: 'Pronouns as a share of total words',
    },
  ]

  let riskScore = 0
  riskScore += clamp(100 - coherence, 0, 100) * 0.35
  riskScore += clamp(100 - lexicalDiversity, 0, 100) * 0.25
  riskScore += clamp((ideaDensity < 4 ? (4 - ideaDensity) / 4 : 0) * 100, 0, 100) * 0.2
  riskScore += clamp((pronounRatio / 25) * 100, 0, 100) * 0.2

  const composite = round0(riskScore)
  const confidence = computeConfidence({
    wordCount: features.wordCount,
    hasTranscript: true,
    type: 'text',
  })

  let summary = 'Linguistic markers computed from the submitted text.'
  if (composite >= 65) {
    summary = 'Linguistic markers suggest possible bulbar or dysarthric speech patterns associated with ALS.'
  } else if (composite >= 35) {
    summary = 'Some linguistic markers fall outside typical ranges.'
  } else {
    summary = 'Linguistic markers are within typical ranges for the extracted features.'
  }

  return {
    modelName: 'ALS-Lex-v1',
    condition: 'ALS',
    riskScore: composite,
    riskLevel: riskFromScore(composite),
    confidence,
    markers,
    summary,
  }
}

export async function analyzeSample(input: AddSampleInput): Promise<{
  durationSeconds?: number
  transcript?: string
  results: NonNullable<Sample['results']>
}> {
  const analysisText = getAnalysisText(input)
  const textFeatures = analysisText ? extractTextFeatures(analysisText) : null

  let audioFeatures: Awaited<ReturnType<typeof extractAudioFeatures>> | null = null
  let durationSeconds: number | undefined

  if (input.audioBlob) {
    audioFeatures = await extractAudioFeatures(input.audioBlob)
    durationSeconds = audioFeatures.durationSeconds
  } else if (input.type === 'text') {
    durationSeconds = undefined
  }

  const wordCount = textFeatures?.wordCount ?? 0

  const parkinson = buildParkinsonResult(
    input.type === 'speech' ? audioFeatures : null,
    wordCount,
    durationSeconds,
  )

  const als = buildAlsResult(analysisText)

  if (
    parkinson.riskScore === null &&
    als.riskScore === null
  ) {
    throw new Error(
      input.type === 'speech'
        ? 'Could not analyze sample. Provide audio with a transcript, or at least 20 characters of transcript text.'
        : 'Could not analyze sample. Text must be at least 20 characters.',
    )
  }

  return {
    durationSeconds,
    transcript: input.transcript,
    results: { parkinson, als },
  }
}

export async function getDurationFromBlob(blob: Blob): Promise<number> {
  return getAudioDuration(blob)
}
