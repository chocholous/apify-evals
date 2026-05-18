import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DatasetDownloadResult {
    datasetIds: string[];
    downloadedCount: number;
    dir: string;
}

const DATASET_ID_PATTERN = /defaultDatasetId.{1,10}?(\w{17})/g;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Scan all events for Apify dataset IDs.
 * They appear in user events (tool results) as JSON strings from `apify actors call --json`.
 * Content may be double-escaped (JSON inside JSON), so we match the raw serialized form.
 * Apify IDs are exactly 17 alphanumeric chars.
 */
export function extractDatasetIdsFromEvents(events: Array<Record<string, unknown>>): string[] {
    const ids = new Set<string>();

    for (const event of events) {
        const serialized = JSON.stringify(event);
        if (!serialized.includes('defaultDatasetId')) continue;

        for (const m of serialized.matchAll(DATASET_ID_PATTERN)) {
            ids.add(m[1]);
        }
    }

    return [...ids];
}

export function downloadApifyDatasets(
    events: Array<Record<string, unknown>>,
    workDir: string,
    env?: Record<string, string>,
): DatasetDownloadResult {
    const datasetIds = extractDatasetIdsFromEvents(events);
    if (datasetIds.length === 0) {
        return { datasetIds: [], downloadedCount: 0, dir: '' };
    }

    const dsDir = join(workDir, 'eval-datasets');
    mkdirSync(dsDir, { recursive: true });

    let downloadedCount = 0;
    const mergedEnv = env ? { ...process.env, ...env } : process.env;
    const token = mergedEnv.APIFY_TOKEN ?? mergedEnv.APIFY_API_TOKEN ?? '';
    const tokenParam = token ? `&token=${token}` : '';

    for (const dsId of datasetIds) {
        try {
            const items = execSync(
                `curl -sf "https://api.apify.com/v2/datasets/${encodeURIComponent(dsId)}/items?format=json${tokenParam}"`,
                { timeout: DOWNLOAD_TIMEOUT_MS, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
            );
            writeFileSync(join(dsDir, `${dsId}.json`), items);
            downloadedCount++;
        } catch { /* skip failed downloads */ }
    }

    return { datasetIds, downloadedCount, dir: dsDir };
}
