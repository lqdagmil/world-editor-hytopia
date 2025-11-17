/**
 * ChunkProcessingWorker.js
 *
 * Background worker for processing terrain data into chunks in parallel.
 * This worker handles the conversion of raw block data into chunk structures
 * without blocking the main thread.
 */

const CHUNK_SIZE = 32;

/**
 * Process a batch of terrain blocks into chunk data
 * @param {Object} terrainBlocks - Object mapping "x,y,z" keys to block IDs
 * @returns {Object} Processed chunk data
 */
function processTerrainBatch(terrainBlocks) {
    const chunks = new Map();
    const blockCount = Object.keys(terrainBlocks).length;
    let processed = 0;

    for (const [posKey, blockId] of Object.entries(terrainBlocks)) {
        // Skip air blocks
        if (blockId === 0 || blockId === null || blockId === undefined) {
            processed++;
            continue;
        }

        const [x, y, z] = posKey.split(",").map(Number);

        // Calculate chunk origin
        const originCoordinate = {
            x: Math.floor(x / CHUNK_SIZE) * CHUNK_SIZE,
            y: Math.floor(y / CHUNK_SIZE) * CHUNK_SIZE,
            z: Math.floor(z / CHUNK_SIZE) * CHUNK_SIZE,
        };

        const chunkId = `${originCoordinate.x},${originCoordinate.y},${originCoordinate.z}`;

        // Get or create chunk data
        if (!chunks.has(chunkId)) {
            chunks.set(chunkId, {
                id: chunkId,
                origin: originCoordinate,
                blocks: [],
            });
        }

        const chunk = chunks.get(chunkId);

        // Calculate local position within chunk
        const localX = x - originCoordinate.x;
        const localY = y - originCoordinate.y;
        const localZ = z - originCoordinate.z;

        chunk.blocks.push({
            position: { x, y, z },
            localPosition: { x: localX, y: localY, z: localZ },
            blockId,
        });

        processed++;
    }

    // Convert Map to plain object for transfer
    const chunksObj = {};
    for (const [chunkId, chunkData] of chunks.entries()) {
        chunksObj[chunkId] = chunkData;
    }

    return {
        chunks: chunksObj,
        blockCount,
        chunkCount: chunks.size,
    };
}

/**
 * Process terrain data in smaller batches to allow progress updates
 * @param {Object} terrainData - Full terrain data object
 * @param {number} batchSize - Number of blocks to process per batch
 * @returns {Object} Processed chunk data with progress info
 */
function processTerrainInBatches(terrainData, batchSize = 5000) {
    const entries = Object.entries(terrainData);
    const totalBlocks = entries.length;
    const chunks = new Map();

    let processed = 0;
    let batchCount = 0;

    // Process in batches
    for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        const batchObj = Object.fromEntries(batch);

        // Process this batch
        for (const [posKey, blockId] of batch) {
            // Skip air blocks
            if (blockId === 0 || blockId === null || blockId === undefined) {
                processed++;
                continue;
            }

            const [x, y, z] = posKey.split(",").map(Number);

            const originCoordinate = {
                x: Math.floor(x / CHUNK_SIZE) * CHUNK_SIZE,
                y: Math.floor(y / CHUNK_SIZE) * CHUNK_SIZE,
                z: Math.floor(z / CHUNK_SIZE) * CHUNK_SIZE,
            };

            const chunkId = `${originCoordinate.x},${originCoordinate.y},${originCoordinate.z}`;

            if (!chunks.has(chunkId)) {
                chunks.set(chunkId, {
                    id: chunkId,
                    origin: originCoordinate,
                    blocks: [],
                });
            }

            const chunk = chunks.get(chunkId);

            const localX = x - originCoordinate.x;
            const localY = y - originCoordinate.y;
            const localZ = z - originCoordinate.z;

            chunk.blocks.push({
                position: { x, y, z },
                localPosition: { x: localX, y: localY, z: localZ },
                blockId,
            });

            processed++;
        }

        batchCount++;

        // Send progress update
        self.postMessage({
            type: 'progress',
            data: {
                processed,
                total: totalBlocks,
                batchCount,
                chunkCount: chunks.size,
                percentage: Math.round((processed / totalBlocks) * 100),
            },
        });
    }

    // Convert Map to plain object
    const chunksObj = {};
    for (const [chunkId, chunkData] of chunks.entries()) {
        chunksObj[chunkId] = chunkData;
    }

    return {
        chunks: chunksObj,
        blockCount: totalBlocks,
        chunkCount: chunks.size,
        processed,
    };
}

/**
 * Build spatial hash grid from terrain data
 * @param {Object} terrainData - Terrain block data
 * @param {number} gridSize - Size of grid cells
 * @returns {Object} Spatial hash grid
 */
function buildSpatialHashBatch(terrainData, gridSize = 32) {
    const grid = new Map();
    const blocks = [];

    for (const [posKey, blockId] of Object.entries(terrainData)) {
        // Skip air blocks
        if (blockId === 0 || blockId === null || blockId === undefined) {
            continue;
        }

        const [x, y, z] = posKey.split(",").map(Number);

        // Calculate grid cell
        const cellX = Math.floor(x / gridSize);
        const cellY = Math.floor(y / gridSize);
        const cellZ = Math.floor(z / gridSize);
        const cellKey = `${cellX},${cellY},${cellZ}`;

        if (!grid.has(cellKey)) {
            grid.set(cellKey, []);
        }

        const blockData = {
            position: { x, y, z },
            blockId,
        };

        grid.get(cellKey).push(blockData);
        blocks.push(blockData);
    }

    // Convert to plain object
    const gridObj = {};
    for (const [cellKey, cellBlocks] of grid.entries()) {
        gridObj[cellKey] = cellBlocks;
    }

    return {
        grid: gridObj,
        blockCount: blocks.length,
        cellCount: grid.size,
        gridSize,
    };
}

// Message handler
self.onmessage = function (event) {
    const { type, data } = event.data;

    try {
        switch (type) {
            case 'processBatch':
                // Process a batch of terrain blocks
                const result = processTerrainBatch(data.terrainBlocks);
                self.postMessage({
                    type: 'batchComplete',
                    data: result,
                });
                break;

            case 'processTerrainWithProgress':
                // Process full terrain with progress updates
                const progressResult = processTerrainInBatches(
                    data.terrainData,
                    data.batchSize || 5000
                );
                self.postMessage({
                    type: 'complete',
                    data: progressResult,
                });
                break;

            case 'buildSpatialHash':
                // Build spatial hash grid
                const hashResult = buildSpatialHashBatch(
                    data.terrainData,
                    data.gridSize || 32
                );
                self.postMessage({
                    type: 'spatialHashComplete',
                    data: hashResult,
                });
                break;

            default:
                console.warn(`Unknown message type: ${type}`);
                self.postMessage({
                    type: 'error',
                    error: `Unknown message type: ${type}`,
                });
        }
    } catch (error) {
        console.error('ChunkProcessingWorker error:', error);
        self.postMessage({
            type: 'error',
            error: error.message,
            stack: error.stack,
        });
    }
};

// Signal that worker is ready
self.postMessage({ type: 'ready' });
