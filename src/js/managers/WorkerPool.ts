/**
 * WorkerPool.ts
 *
 * Manages a pool of Web Workers for parallel chunk processing.
 * Distributes work across multiple workers to maximize CPU utilization.
 */

interface WorkerTask {
    id: string;
    type: string;
    data: any;
    resolve: (value: any) => void;
    reject: (error: any) => void;
}

interface PoolWorker {
    worker: Worker;
    busy: boolean;
    taskId: string | null;
}

export class WorkerPool {
    private workers: PoolWorker[] = [];
    private queue: WorkerTask[] = [];
    private workerPath: string;
    private maxWorkers: number;
    private taskCounter: number = 0;
    private activeTasks: Map<string, WorkerTask> = new Map();

    constructor(workerPath: string, maxWorkers: number = navigator.hardwareConcurrency || 4) {
        this.workerPath = workerPath;
        this.maxWorkers = Math.max(1, Math.min(maxWorkers, 8)); // Limit to reasonable range
        this.initializeWorkers();
    }

    /**
     * Initialize worker pool
     */
    private initializeWorkers(): void {
        for (let i = 0; i < this.maxWorkers; i++) {
            try {
                const worker = new Worker(this.workerPath);
                const poolWorker: PoolWorker = {
                    worker,
                    busy: false,
                    taskId: null,
                };

                worker.onmessage = (event) => this.handleWorkerMessage(poolWorker, event);
                worker.onerror = (error) => this.handleWorkerError(poolWorker, error);

                this.workers.push(poolWorker);
            } catch (error) {
                console.error(`Failed to create worker ${i}:`, error);
            }
        }

        console.log(`WorkerPool initialized with ${this.workers.length} workers`);
    }

    /**
     * Handle messages from workers
     */
    private handleWorkerMessage(poolWorker: PoolWorker, event: MessageEvent): void {
        const { type, data, error } = event.data;

        // Handle ready message
        if (type === 'ready') {
            console.log('Worker ready');
            return;
        }

        // Handle progress updates
        if (type === 'progress') {
            const task = poolWorker.taskId ? this.activeTasks.get(poolWorker.taskId) : null;
            if (task && task.data.onProgress) {
                task.data.onProgress(data);
            }
            return;
        }

        // Handle task completion or error
        if (!poolWorker.taskId) {
            console.warn('Received message from worker with no active task');
            return;
        }

        const task = this.activeTasks.get(poolWorker.taskId);
        if (!task) {
            console.warn(`No task found for ID: ${poolWorker.taskId}`);
            poolWorker.busy = false;
            poolWorker.taskId = null;
            this.processQueue();
            return;
        }

        // Mark worker as available
        poolWorker.busy = false;
        poolWorker.taskId = null;
        this.activeTasks.delete(task.id);

        // Resolve or reject the task
        if (type === 'error' || error) {
            task.reject(new Error(error || 'Worker error'));
        } else {
            task.resolve(data);
        }

        // Process next task in queue
        this.processQueue();
    }

    /**
     * Handle worker errors
     */
    private handleWorkerError(poolWorker: PoolWorker, error: ErrorEvent): void {
        console.error('Worker error:', error);

        if (poolWorker.taskId) {
            const task = this.activeTasks.get(poolWorker.taskId);
            if (task) {
                task.reject(new Error(`Worker error: ${error.message}`));
                this.activeTasks.delete(poolWorker.taskId);
            }
        }

        poolWorker.busy = false;
        poolWorker.taskId = null;
        this.processQueue();
    }

    /**
     * Execute a task on an available worker
     */
    public execute(type: string, data: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const taskId = `task_${++this.taskCounter}`;
            const task: WorkerTask = {
                id: taskId,
                type,
                data,
                resolve,
                reject,
            };

            this.queue.push(task);
            this.processQueue();
        });
    }

    /**
     * Execute multiple tasks in parallel
     */
    public executeParallel(tasks: Array<{ type: string; data: any }>): Promise<any[]> {
        const promises = tasks.map(task => this.execute(task.type, task.data));
        return Promise.all(promises);
    }

    /**
     * Execute tasks in batches with a limit
     */
    public async executeBatches(
        tasks: Array<{ type: string; data: any }>,
        onBatchComplete?: (results: any[], batchIndex: number) => void
    ): Promise<any[]> {
        const results: any[] = [];
        const batchSize = this.maxWorkers;

        for (let i = 0; i < tasks.length; i += batchSize) {
            const batch = tasks.slice(i, i + batchSize);
            const batchResults = await this.executeParallel(batch);
            results.push(...batchResults);

            if (onBatchComplete) {
                onBatchComplete(batchResults, Math.floor(i / batchSize));
            }
        }

        return results;
    }

    /**
     * Process the task queue
     */
    private processQueue(): void {
        if (this.queue.length === 0) {
            return;
        }

        // Find available worker
        const availableWorker = this.workers.find(w => !w.busy);
        if (!availableWorker) {
            return;
        }

        // Get next task
        const task = this.queue.shift();
        if (!task) {
            return;
        }

        // Assign task to worker
        availableWorker.busy = true;
        availableWorker.taskId = task.id;
        this.activeTasks.set(task.id, task);

        // Send task to worker
        try {
            availableWorker.worker.postMessage({
                type: task.type,
                data: task.data,
            });
        } catch (error) {
            console.error('Failed to post message to worker:', error);
            availableWorker.busy = false;
            availableWorker.taskId = null;
            this.activeTasks.delete(task.id);
            task.reject(error);
            this.processQueue();
        }

        // Continue processing queue if more workers available
        if (this.queue.length > 0) {
            this.processQueue();
        }
    }

    /**
     * Get pool statistics
     */
    public getStats(): {
        totalWorkers: number;
        busyWorkers: number;
        availableWorkers: number;
        queuedTasks: number;
        activeTasks: number;
    } {
        const busyCount = this.workers.filter(w => w.busy).length;
        return {
            totalWorkers: this.workers.length,
            busyWorkers: busyCount,
            availableWorkers: this.workers.length - busyCount,
            queuedTasks: this.queue.length,
            activeTasks: this.activeTasks.size,
        };
    }

    /**
     * Clear all pending tasks
     */
    public clearQueue(): void {
        this.queue.forEach(task => {
            task.reject(new Error('Task cancelled'));
        });
        this.queue = [];
    }

    /**
     * Terminate all workers and clean up
     */
    public terminate(): void {
        this.clearQueue();

        this.workers.forEach(poolWorker => {
            poolWorker.worker.terminate();
        });

        this.workers = [];
        this.activeTasks.clear();
        console.log('WorkerPool terminated');
    }

    /**
     * Check if pool is idle (no active or queued tasks)
     */
    public isIdle(): boolean {
        return this.queue.length === 0 && this.activeTasks.size === 0;
    }

    /**
     * Wait for all tasks to complete
     */
    public async waitForIdle(): Promise<void> {
        return new Promise((resolve) => {
            const checkIdle = () => {
                if (this.isIdle()) {
                    resolve();
                } else {
                    setTimeout(checkIdle, 100);
                }
            };
            checkIdle();
        });
    }
}

// Singleton instance for chunk processing
let chunkProcessingPool: WorkerPool | null = null;

export function getChunkProcessingPool(): WorkerPool {
    if (!chunkProcessingPool) {
        chunkProcessingPool = new WorkerPool(
            new URL('../workers/ChunkProcessingWorker.js', import.meta.url).href,
            navigator.hardwareConcurrency || 4
        );
    }
    return chunkProcessingPool;
}

export function terminateChunkProcessingPool(): void {
    if (chunkProcessingPool) {
        chunkProcessingPool.terminate();
        chunkProcessingPool = null;
    }
}
