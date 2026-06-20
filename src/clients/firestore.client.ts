/**
 * Firestore Admin SDK Client
 *
 * Client for interacting with Firestore using the Firebase Admin SDK.
 */

import * as admin from 'firebase-admin';
import { AppConfig } from '../config';
import {
  CertenUserWithAdis,
  CertenAdi,
  CertenKeyBook,
  PendingActionDocument,
  ComputedPendingState,
  FirestoreSigningPath,
} from '../types';
import { logger, logFirestoreOp } from '../utils/logger';
import { encodeUrlForDocId } from '../utils/url-normalizer';

export class FirestoreClient {
  private readonly db: admin.firestore.Firestore;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;

    // Initialize Firebase Admin SDK
    if (!admin.apps.length) {
      const initOptions: admin.AppOptions = {
        projectId: config.firebaseProjectId,
      };

      // Use credentials file if provided
      if (config.googleCredentialsPath) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const serviceAccount = require(config.googleCredentialsPath);
        initOptions.credential = admin.credential.cert(serviceAccount);
      } else {
        // Use application default credentials
        initOptions.credential = admin.credential.applicationDefault();
      }

      admin.initializeApp(initOptions);
    }

    this.db = admin.firestore();

    // Tolerate `undefined` field values on writes by silently dropping them.
    // Without this, a single optional field set to `undefined` aborts the entire
    // write with "Cannot use undefined as a Firestore value".
    this.db.settings({ ignoreUndefinedProperties: true });

    // Configure Firestore emulator if specified
    if (config.firestoreEmulatorHost) {
      process.env.FIRESTORE_EMULATOR_HOST = config.firestoreEmulatorHost;
      logger.info('Using Firestore emulator', { host: config.firestoreEmulatorHost });
    }
  }

  /**
   * Firestore caps a WriteBatch at 500 operations. Commit a list of batch
   * operations in chunks under that limit. Note: chunking trades the
   * all-or-nothing atomicity of a single batch for the ability to exceed 500
   * ops; since the poller recomputes and rewrites state every cycle, a partial
   * commit self-heals on the next pass.
   */
  private async commitInChunks(
    ops: Array<(batch: admin.firestore.WriteBatch) => void>
  ): Promise<void> {
    const MAX_BATCH_OPS = 450; // margin under Firestore's hard 500 limit
    for (let i = 0; i < ops.length; i += MAX_BATCH_OPS) {
      const batch = this.db.batch();
      for (const op of ops.slice(i, i + MAX_BATCH_OPS)) {
        op(batch);
      }
      await batch.commit();
    }
  }

  /**
   * List all users with their ADIs
   */
  async listUsersWithAdis(): Promise<CertenUserWithAdis[]> {
    const usersCollection = this.db.collection(this.config.usersCollection);
    // Only onboarded users are relevant — filter at the query so we don't read
    // the entire users collection every poll cycle. keyVaultSetup is filtered
    // in memory below to avoid requiring a composite index.
    const usersSnapshot = await usersCollection.where('onboardingComplete', '==', true).get();

    const users: CertenUserWithAdis[] = [];

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();

      // Skip users without key vault setup
      if (!userData.keyVaultSetup) {
        continue;
      }

      // Get user's ADIs
      const adisCollection = usersCollection.doc(userDoc.id).collection('adis');
      const adisSnapshot = await adisCollection.get();

      const adis: CertenAdi[] = adisSnapshot.docs.map(adiDoc => adiDoc.data() as CertenAdi);

      users.push({
        uid: userDoc.id,
        email: userData.email || '',
        displayName: userData.displayName,
        defaultAdiUrl: userData.defaultAdiUrl,
        adis,
      });
    }

    logFirestoreOp('read', this.config.usersCollection, users.length);

    return users;
  }

  /**
   * Get a single user with their ADIs
   */
  async getUserWithAdis(uid: string): Promise<CertenUserWithAdis | null> {
    const userRef = this.db.collection(this.config.usersCollection).doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return null;
    }

    const userData = userDoc.data()!;

    // Get user's ADIs
    const adisCollection = userRef.collection('adis');
    const adisSnapshot = await adisCollection.get();

    const adis: CertenAdi[] = adisSnapshot.docs.map(adiDoc => adiDoc.data() as CertenAdi);

    logFirestoreOp('read', 'users/adis', 1 + adis.length);

    return {
      uid: userDoc.id,
      email: userData.email || '',
      displayName: userData.displayName,
      defaultAdiUrl: userData.defaultAdiUrl,
      adis,
    };
  }

  /**
   * Get current pending actions for a user
   */
  async getPendingActions(uid: string): Promise<PendingActionDocument[]> {
    const pendingRef = this.db
      .collection(this.config.usersCollection)
      .doc(uid)
      .collection(this.config.pendingActionsSubcollection);

    const snapshot = await pendingRef.get();

    logFirestoreOp('read', 'pendingActions', snapshot.size);

    return snapshot.docs.map(doc => doc.data() as PendingActionDocument);
  }

  /**
   * Get computed pending state for a user
   */
  async getComputedState(uid: string): Promise<ComputedPendingState | null> {
    const computedRef = this.db
      .collection(this.config.usersCollection)
      .doc(uid)
      .collection(this.config.computedStateSubcollection)
      .doc('pending');

    const doc = await computedRef.get();

    logFirestoreOp('read', 'computedState', 1);

    return doc.exists ? (doc.data() as ComputedPendingState) : null;
  }

  /**
   * Atomically update a user's pending actions
   */
  async updatePendingActions(
    uid: string,
    toAdd: PendingActionDocument[],
    toRemove: string[],
    computedState: ComputedPendingState
  ): Promise<void> {
    const userRef = this.db.collection(this.config.usersCollection).doc(uid);
    const pendingRef = userRef.collection(this.config.pendingActionsSubcollection);
    const computedRef = userRef.collection(this.config.computedStateSubcollection).doc('pending');

    // Build all operations, then commit in chunks so a large add/remove set
    // can't blow past Firestore's 500-op batch limit. ADDS commit before
    // DELETES (delete-last): chunking isn't atomic, so if a commit is
    // interrupted mid-way (e.g. SIGTERM during a deploy) we'd rather leave a
    // few stale extra docs (self-heal next cycle) than a half-emptied inbox.
    // The computed-state write is last so it reflects the final set.
    const ops: Array<(batch: admin.firestore.WriteBatch) => void> = [];
    for (const action of toAdd) {
      ops.push(batch => batch.set(pendingRef.doc(action.id), action, { merge: true }));
    }
    for (const docId of toRemove) {
      ops.push(batch => batch.delete(pendingRef.doc(docId)));
    }
    ops.push(batch => batch.set(computedRef, computedState, { merge: true }));

    await this.commitInChunks(ops);

    logFirestoreOp('write', 'pendingActions', toAdd.length + toRemove.length + 1);
  }

  /**
   * Delete all pending actions for a user
   */
  async clearPendingActions(uid: string): Promise<void> {
    const pendingRef = this.db
      .collection(this.config.usersCollection)
      .doc(uid)
      .collection(this.config.pendingActionsSubcollection);

    const snapshot = await pendingRef.get();

    if (snapshot.empty) {
      return;
    }

    // Chunk the deletes so clearing more than 500 pending actions doesn't
    // exceed Firestore's batch limit.
    await this.commitInChunks(
      snapshot.docs.map(doc => (batch: admin.firestore.WriteBatch) => batch.delete(doc.ref))
    );

    logFirestoreOp('delete', 'pendingActions', snapshot.size);
  }

  /**
   * Update signing paths on the user document
   */
  async updateUserSigningPaths(
    uid: string,
    signingPaths: string[],
    signingPathsByAdi: Record<string, string[]>
  ): Promise<void> {
    const userRef = this.db.collection(this.config.usersCollection).doc(uid);
    await userRef.update({
      signingPaths,
      signingPathsByAdi,
      signingPathsLastUpdated: admin.firestore.Timestamp.now(),
    });

    logFirestoreOp('write', 'users/signingPaths', 1);
  }

  /**
   * Update structured signing paths on the user document.
   * Writes the full structured path data alongside the legacy flat strings.
   */
  async updateUserSigningPathsStructured(
    uid: string,
    structuredPaths: FirestoreSigningPath[]
  ): Promise<void> {
    const userRef = this.db.collection(this.config.usersCollection).doc(uid);
    await userRef.update({
      signingPathsStructured: structuredPaths,
      signingPathsLastUpdated: admin.firestore.Timestamp.now(),
    });

    logFirestoreOp('write', 'users/signingPathsStructured', 1);
  }

  /**
   * Update key books on an ADI document
   */
  async updateAdiKeyBooks(uid: string, adiUrl: string, keyBooks: CertenKeyBook[]): Promise<void> {
    const adiDocId = encodeUrlForDocId(adiUrl);
    const adiRef = this.db
      .collection(this.config.usersCollection)
      .doc(uid)
      .collection('adis')
      .doc(adiDocId);

    await adiRef.update({
      keyBooks,
      updatedAt: admin.firestore.Timestamp.now(),
    });

    logFirestoreOp('write', `adis/${adiUrl}`, 1);
  }

  /**
   * Get Firestore server timestamp
   */
  getServerTimestamp(): admin.firestore.FieldValue {
    return admin.firestore.FieldValue.serverTimestamp();
  }

  /**
   * Create a Timestamp from a Date
   */
  createTimestamp(date: Date): admin.firestore.Timestamp {
    return admin.firestore.Timestamp.fromDate(date);
  }

  /**
   * Get current timestamp
   */
  now(): admin.firestore.Timestamp {
    return admin.firestore.Timestamp.now();
  }
}
