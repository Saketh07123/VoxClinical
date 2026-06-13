import type { Sample } from '../types'

const SAMPLES_KEY = 'voxclinical-samples-v1'
const LEGACY_SAMPLE_KEYS = ['segregate-samples-v3', 'segregate-samples-v2']
const DB_NAME = 'voxclinical-audio'
const LEGACY_DB_NAME = 'segregate-audio'
const STORE_NAME = 'blobs'

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readBlobFromDb(dbName: string, sampleId: string): Promise<Blob | null> {
  const db = await openDb(dbName)
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(sampleId)
    request.onsuccess = () => resolve((request.result as Blob) ?? null)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return blob
}

export async function saveAudioBlob(sampleId: string, blob: Blob): Promise<void> {
  const db = await openDb(DB_NAME)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(blob, sampleId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function loadAudioBlob(sampleId: string): Promise<Blob | null> {
  const blob = await readBlobFromDb(DB_NAME, sampleId)
  if (blob) return blob

  const legacyBlob = await readBlobFromDb(LEGACY_DB_NAME, sampleId)
  if (legacyBlob) {
    await saveAudioBlob(sampleId, legacyBlob)
    return legacyBlob
  }

  return null
}

export async function deleteAudioBlob(sampleId: string): Promise<void> {
  const db = await openDb(DB_NAME)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(sampleId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

function migrateSample(raw: unknown): Sample {
  const sample = raw as Sample & {
    results?: {
      parkinson?: unknown
      dysarthria?: unknown
      alzheimer?: Record<string, unknown>
      parkinsonAcoustic?: unknown
    }
  }

  // Already in new 4-model format
  if (sample.results?.parkinsonAcoustic !== undefined) {
    return sample as Sample
  }

  // Drop results from old 2-model format — re-analysis needed
  if (sample.results?.parkinson !== undefined || sample.results?.dysarthria !== undefined) {
    return { ...sample, results: undefined, status: 'failed', errorMessage: 'Re-submit to run updated 4-model analysis.' }
  }

  return sample as Sample
}

function parseSamples(raw: string): Sample[] {
  return (JSON.parse(raw) as unknown[]).map(migrateSample)
}

export function loadSamples(): Sample[] {
  try {
    const raw = localStorage.getItem(SAMPLES_KEY)
    if (raw) return parseSamples(raw)

    for (const legacyKey of LEGACY_SAMPLE_KEYS) {
      const legacyRaw = localStorage.getItem(legacyKey)
      if (legacyRaw) {
        const migrated = parseSamples(legacyRaw)
        saveSamples(migrated)
        return migrated
      }
    }

    return []
  } catch {
    return []
  }
}

export function saveSamples(samples: Sample[]): void {
  localStorage.setItem(SAMPLES_KEY, JSON.stringify(samples))
}

export async function deleteSampleData(sampleId: string): Promise<void> {
  await deleteAudioBlob(sampleId)
}
