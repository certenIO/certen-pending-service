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
  PendingActionDocument,
  ComputedPendingState,
} from '../types';
import { logger, logFirestoreOp } from '../utils/logger';

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

    // Configure Firestore emulator if specified
    if (config.firestoreEmulatorHost) {
      process.env.FIRESTORE_EMULATOR_HOST = config.firestoreEmulatorHost;
      logger.info('Using Firestore emulator', { host: config.firestoreEmulatorHost });
    }
  }

  /**
   * List all users with their ADIs
   */
  async listUsersWithAdis(): Promise<CertenUserWithAdis[]> {
    const usersCollection = this.db.collection(this.config.usersCollection);
    const usersSnapshot = await usersCollection.get();

    const users: CertenUserWithAdis[] = [];

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();

      // Skip users without onboarding complete or key vault setup
      if (!userData.onboardingComplete || !userData.keyVaultSetup) {
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
    const batch = this.db.batch();

    const userRef = this.db.collection(this.config.usersCollection).doc(uid);
    const pendingRef = userRef.collection(this.config.pendingActionsSubcollection);
    const computedRef = userRef.collection(this.config.computedStateSubcollection).doc('pending');

    // Remove old pending actions
    for (const docId of toRemove) {
      batch.delete(pendingRef.doc(docId));
    }

    // Add/update pending actions
    for (const action of toAdd) {
      batch.set(pendingRef.doc(action.id), action, { merge: true });
    }

    // Update computed state
    batch.set(computedRef, computedState, { merge: true });

    await batch.commit();

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

    const batch = this.db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    logFirestoreOp('delete', 'pendingActions', snapshot.size);
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
