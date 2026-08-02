import type {
  StoredBurstMarker,
  StoredMediaChunk,
  StoredRecording,
} from "./types";

const DATABASE_NAME = "crowdcut-media-v1";
const DATABASE_VERSION = 1;
const RECORDINGS = "recordings";
const CHUNKS = "chunks";
const BURSTS = "bursts";

export class MediaPersistenceError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MediaPersistenceError";
    this.cause = cause;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

export class MediaChunkStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  async open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      throw new MediaPersistenceError(
        "Durable recording requires IndexedDB, which is unavailable in this browser.",
      );
    }

    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

        request.onupgradeneeded = () => {
          const database = request.result;

          if (!database.objectStoreNames.contains(RECORDINGS)) {
            const recordings = database.createObjectStore(RECORDINGS, { keyPath: "id" });
            recordings.createIndex("status", "status", { unique: false });
            recordings.createIndex("createdAtMs", "createdAtMs", { unique: false });
          }

          if (!database.objectStoreNames.contains(CHUNKS)) {
            const chunks = database.createObjectStore(CHUNKS, { keyPath: "key" });
            chunks.createIndex("recordingId", "recordingId", { unique: false });
            chunks.createIndex("uploadState", "uploadState", { unique: false });
          }

          if (!database.objectStoreNames.contains(BURSTS)) {
            const bursts = database.createObjectStore(BURSTS, { keyPath: "id" });
            bursts.createIndex("recordingId", "recordingId", { unique: false });
          }
        };

        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => database.close();
          resolve(database);
        };
        request.onerror = () =>
          reject(new MediaPersistenceError("Could not open durable media storage.", request.error));
        request.onblocked = () =>
          reject(new MediaPersistenceError("A previous CrowdCut tab is blocking media recovery."));
      });
    }

    return this.databasePromise;
  }

  async putRecording(recording: StoredRecording): Promise<void> {
    await this.write(RECORDINGS, (store) => store.put(recording));
  }

  async getRecording(id: string): Promise<StoredRecording | undefined> {
    const database = await this.open();
    const transaction = database.transaction(RECORDINGS, "readonly");
    const value = await requestResult(
      transaction.objectStore(RECORDINGS).get(id) as IDBRequest<StoredRecording | undefined>,
    );
    await transactionDone(transaction);
    return value;
  }

  async putChunk(chunk: StoredMediaChunk): Promise<void> {
    await this.write(CHUNKS, (store) => store.put(chunk));
  }

  async putBurstMarker(marker: StoredBurstMarker): Promise<void> {
    await this.write(BURSTS, (store) => store.put(marker));
  }

  async listChunks(recordingId: string): Promise<StoredMediaChunk[]> {
    const database = await this.open();
    const transaction = database.transaction(CHUNKS, "readonly");
    const index = transaction.objectStore(CHUNKS).index("recordingId");
    const chunks = await requestResult(
      index.getAll(recordingId) as IDBRequest<StoredMediaChunk[]>,
    );
    await transactionDone(transaction);
    return chunks.sort((a, b) => a.sequence - b.sequence);
  }

  async listChunksInWindow(
    recordingId: string,
    startAtMs: number,
    endAtMs: number,
  ): Promise<StoredMediaChunk[]> {
    const chunks = await this.listChunks(recordingId);
    return chunks.filter(
      (chunk) => chunk.endAtMs >= startAtMs && chunk.startAtMs <= endAtMs,
    );
  }

  async listPendingChunks(): Promise<StoredMediaChunk[]> {
    const database = await this.open();
    const transaction = database.transaction(CHUNKS, "readonly");
    const index = transaction.objectStore(CHUNKS).index("uploadState");
    const states: StoredMediaChunk["uploadState"][] = ["pending", "failed"];
    const lists = await Promise.all(
      states.map((state) =>
        requestResult(index.getAll(state) as IDBRequest<StoredMediaChunk[]>),
      ),
    );
    await transactionDone(transaction);
    return lists.flat().sort((a, b) => a.startAtMs - b.startAtMs);
  }

  async updateChunkUpload(
    key: string,
    uploadState: StoredMediaChunk["uploadState"],
    remoteStorageId?: string,
  ): Promise<StoredMediaChunk> {
    const database = await this.open();
    const transaction = database.transaction(CHUNKS, "readwrite");
    const store = transaction.objectStore(CHUNKS);
    const chunk = await requestResult(
      store.get(key) as IDBRequest<StoredMediaChunk | undefined>,
    );
    if (!chunk) {
      transaction.abort();
      throw new MediaPersistenceError(`Media chunk ${key} does not exist.`);
    }
    const updated: StoredMediaChunk = {
      ...chunk,
      uploadState,
      uploadAttempts:
        uploadState === "uploading" || uploadState === "failed"
          ? chunk.uploadAttempts + 1
          : chunk.uploadAttempts,
      ...(remoteStorageId ? { remoteStorageId } : {}),
    };
    store.put(updated);
    await transactionDone(transaction);
    return updated;
  }

  async recoverRecordings(staleAfterMs = 60_000): Promise<StoredRecording[]> {
    const database = await this.open();
    const transaction = database.transaction(RECORDINGS, "readwrite");
    const store = transaction.objectStore(RECORDINGS);
    const recordings = await requestResult(store.getAll() as IDBRequest<StoredRecording[]>);
    const recovered = recordings.map((recording) => {
      if (
        recording.status !== "recording" ||
        recording.updatedAtMs > Date.now() - staleAfterMs
      ) {
        return recording;
      }
      const interrupted: StoredRecording = {
        ...recording,
        status: "interrupted",
        stoppedAtMs: recording.stoppedAtMs ?? Date.now(),
        updatedAtMs: Date.now(),
      };
      store.put(interrupted);
      return interrupted;
    });
    await transactionDone(transaction);
    return recovered.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  async deleteRecording(id: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction([RECORDINGS, CHUNKS, BURSTS], "readwrite");
    transaction.objectStore(RECORDINGS).delete(id);
    const chunks = transaction.objectStore(CHUNKS).index("recordingId");
    const bursts = transaction.objectStore(BURSTS).index("recordingId");
    await Promise.all([
      this.deleteCursor(chunks, id),
      this.deleteCursor(bursts, id),
    ]);
    await transactionDone(transaction);
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = null;
  }

  private async write(
    storeName: string,
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<void> {
    try {
      const database = await this.open();
      const transaction = database.transaction(storeName, "readwrite");
      operation(transaction.objectStore(storeName));
      await transactionDone(transaction);
    } catch (error) {
      if (error instanceof MediaPersistenceError) throw error;
      throw new MediaPersistenceError("The recording could not be saved locally.", error);
    }
  }

  private deleteCursor(index: IDBIndex, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = index.openKeyCursor(IDBKeyRange.only(key));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }
}

export const mediaChunkStore = new MediaChunkStore();
