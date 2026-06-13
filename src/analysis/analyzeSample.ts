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

// ── PD Acoustic (ParkSpeech-v2) ─────────────────────────────────────────────
// Markers: speech rate, pause frequency, avg pause duration, prosody variation

function buildParkinsonAcousticResult(
  audioFeatures: AudioFeatures | null,
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
      description: 'Words per minute — reduced rate and irregularity are hallmarks of hypokinetic dysarthria in PD',
    })
  }

  if (audioFeatures) {
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
        description: 'RMS energy variation across the recording — monotone speech is a key PD acoustic marker',
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
      summary: 'No audio provided. Submit a speech recording for acoustic PD analysis.',
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
    if (composite >= 65) summary = 'Acoustic markers show elevated pause frequency or reduced prosody variation consistent with hypokinetic dysarthria.'
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

// ── PD Linguistic (ParkLex-v1) ───────────────────────────────────────────────
// Markers: lexical richness, avg sentence length, content word ratio

function buildParkinsonLinguisticResult(text: string | null): ModelResult {
  if (!text || text.trim().length < 20) {
    return {
      modelName: 'ParkLex-v1',
      condition: "Parkinson's",
      riskScore: null,
      riskLevel: null,
      confidence: null,
      markers: [],
      summary: 'Insufficient text. Provide at least 20 characters of transcript or text content.',
    }
  }

  const features = extractTextFeatures(text)
  const lexicalRichness = round0(features.typeTokenRatio * 100)
  const avgSentenceLength = round1(features.avgWordsPerSentence)
  const contentWordRatio = round0(features.contentWordRatio)

  const markers = [
    {
      id: 'lexical-richness',
      label: 'Lexical richness',
      value: lexicalRichness,
      unit: '%',
      description: 'Type-token ratio — vocabulary breadth relative to total words; reduced in PD-related language changes',
    },
    {
      id: 'sentence-length',
      label: 'Avg sentence length',
      value: avgSentenceLength,
      unit: 'words',
      description: 'Mean words per sentence — syntactic simplification leads to shorter sentences in PD',
    },
    {
      id: 'content-ratio',
      label: 'Content word ratio',
      value: contentWordRatio,
      unit: '%',
      description: 'Share of content (non-function) words — reduced ratio reflects lexical access difficulties',
    },
  ]

  let riskScore = 0
  riskScore += clamp(100 - lexicalRichness, 0, 100) * 0.4
  riskScore += clamp(((10 - Math.min(avgSentenceLength, 10)) / 10) * 100, 0, 100) * 0.3
  riskScore += clamp(100 - contentWordRatio, 0, 100) * 0.3

  const composite = round0(riskScore)
  const confidence = computeConfidence({
    wordCount: features.wordCount,
    hasTranscript: true,
    type: 'text',
  })

  let summary = 'Linguistic markers computed from the submitted text.'
  if (composite >= 65) {
    summary = 'Linguistic markers suggest reduced lexical richness and syntactic simplification associated with PD.'
  } else if (composite >= 35) {
    summary = 'Some linguistic markers fall outside typical ranges.'
  } else {
    summary = 'Linguistic markers are within typical ranges for the extracted features.'
  }

  return {
    modelName: 'ParkLex-v1',
    condition: "Parkinson's",
    riskScore: composite,
    riskLevel: riskFromScore(composite),
    confidence,
    markers,
    summary,
  }
}

// ── Dysarthria Acoustic (DysarthriaSpeech-v1) ─────────────────────────────────────────────
// Markers: speech rate, avg pause duration, pause frequency, prosody variation
// Dysarthria causes progressive articulatory weakness — slower rate, prolonged pauses

function buildDysarthriaAcousticResult(
  audioFeatures: AudioFeatures | null,
  wordCount: number,
  durationSeconds: number | undefined,
): ModelResult {
  if (!audioFeatures) {
    return {
      modelName: 'DysarthriaSpeech-v1',
      condition: 'Dysarthria',
      riskScore: null,
      riskLevel: null,
      confidence: null,
      markers: [],
      summary: 'No audio provided. Submit a speech recording for acoustic dysarthria analysis.',
    }
  }

  const markers = []

  if (durationSeconds && durationSeconds > 0 && wordCount > 0) {
    const speechRate = round0((wordCount / durationSeconds) * 60)
    markers.push({
      id: 'speech-rate',
      label: 'Speech rate',
      value: speechRate,
      unit: 'wpm',
      description: 'Words per minute — articulatory muscle weakness in dysarthria causes progressive speech slowing',
    })
  }

  markers.push(
    {
      id: 'avg-pause',
      label: 'Avg pause duration',
      value: audioFeatures.avgPauseDurationMs,
      unit: 'ms',
      description: 'Mean pause length — prolonged pauses reflect articulatory fatigue characteristic of dysarthria',
    },
    {
      id: 'pause-freq',
      label: 'Pause frequency',
      value: audioFeatures.pauseFrequencyPerMinute,
      unit: '/min',
      description: 'Silent segments ≥250ms per minute detected from amplitude',
    },
    {
      id: 'prosody',
      label: 'Prosody variation',
      value: audioFeatures.prosodyVariation,
      unit: '%',
      description: 'Energy variation across the recording — flat prosody indicates bulbar motor involvement',
    },
  )

  const speechRateMarker = markers.find((m) => m.id === 'speech-rate')
  const avgPauseMarker = markers.find((m) => m.id === 'avg-pause')
  const pauseFreqMarker = markers.find((m) => m.id === 'pause-freq')
  const prosodyMarker = markers.find((m) => m.id === 'prosody')

  let riskScore = 0
  let factors = 0

  if (speechRateMarker) {
    const rate = speechRateMarker.value
    // Dysarthria: strong signal below 90 wpm; mild signal above 160 wpm (rushing due to breath support loss)
    if (rate < 90) riskScore += clamp(((90 - rate) / 60) * 100, 0, 100)
    else if (rate > 160) riskScore += clamp(((rate - 160) / 60) * 100, 0, 100) * 0.3
    factors++
  }

  if (avgPauseMarker) {
    // Dysarthria: pause duration is a stronger signal than frequency (articulatory fatigue)
    riskScore += clamp((avgPauseMarker.value / 800) * 100, 0, 100)
    factors++
  }

  if (pauseFreqMarker) {
    riskScore += clamp((pauseFreqMarker.value / 12) * 100, 0, 100)
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
    if (composite >= 65) summary = 'Acoustic markers suggest bulbar motor involvement — reduced speech rate or prolonged pauses consistent with dysarthria.'
    else if (composite >= 35) summary = 'Some acoustic markers fall outside typical ranges.'
    else summary = 'Acoustic markers are within typical ranges for the extracted features.'
  }

  return {
    modelName: 'DysarthriaSpeech-v1',
    condition: 'Dysarthria',
    riskScore: composite,
    riskLevel: composite !== null ? riskFromScore(composite) : null,
    confidence: composite !== null ? confidence : null,
    markers,
    summary,
  }
}

// ── Dysarthria Linguistic (DysarthriaLex-v1) ──────────────────────────────────────────────
// Markers: semantic coherence, lexical diversity, idea density, pronoun ratio

function buildDysarthriaLinguisticResult(text: string | null): ModelResult {
  if (!text || text.trim().length < 20) {
    return {
      modelName: 'DysarthriaLex-v1',
      condition: 'Dysarthria',
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
      description: 'Keyword overlap between consecutive sentences — dysarthria-related cognitive involvement reduces coherence',
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
      description: 'Content words per sentence — reduced in dysarthria-related language changes',
    },
    {
      id: 'pronoun-ratio',
      label: 'Pronoun ratio',
      value: pronounRatio,
      unit: '%',
      description: 'Pronouns as a share of total words — elevated ratio is associated with reduced lexical access',
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
    summary = 'Linguistic markers suggest possible bulbar or cognitive speech patterns associated with dysarthria.'
  } else if (composite >= 35) {
    summary = 'Some linguistic markers fall outside typical ranges.'
  } else {
    summary = 'Linguistic markers are within typical ranges for the extracted features.'
  }

  return {
    modelName: 'DysarthriaLex-v1',
    condition: 'Dysarthria',
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

  const parkinsonAcoustic = buildParkinsonAcousticResult(speechAudio, wordCount, durationSeconds)
  const parkinsonLinguistic = buildParkinsonLinguisticResult(analysisText)
  const dysarthriaAcoustic = buildDysarthriaAcousticResult(speechAudio, wordCount, durationSeconds)
  const dysarthriaLinguistic = buildDysarthriaLinguisticResult(analysisText)

  const allNull = [parkinsonAcoustic, parkinsonLinguistic, dysarthriaAcoustic, dysarthriaLinguistic]
    .every((r) => r.riskScore === null)

  if (allNull) {
    throw new Error(
      input.type === 'speech'
        ? 'Could not analyze sample. Provide audio with a transcript, or at least 20 characters of transcript text.'
        : 'Could not analyze sample. Text must be at least 20 characters.',
    )
  }

  return {
    durationSeconds,
    transcript: input.transcript,
    results: { parkinsonAcoustic, parkinsonLinguistic, dysarthriaAcoustic, dysarthriaLinguistic },
  }
}

export async function getDurationFromBlob(blob: Blob): Promise<number> {
  return getAudioDuration(blob)
}
