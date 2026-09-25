/**
 * The catalog snapshot format every SDK writes and reads (SNAP-1): `langsys-catalog-snapshot`
 * version 1, checksummed over a canonical serialisation. It is the core's, from `/pure`, so the
 * bytes a snapshot hashes to are computed by one implementation for the whole JavaScript family;
 * the shared `snapshot-vectors.json` holds every other core to the same bytes.
 */
export {
    SNAPSHOT_FORMAT,
    SNAPSHOT_VERSION,
    SnapshotError,
    buildSnapshot,
    canonicalSnapshotJson,
    parseSnapshot,
    snapshotChecksum,
    type CatalogSnapshot,
    type SnapshotCatalog,
    type SnapshotCategory,
    type SnapshotRefusal,
} from 'langsys-js-typescript/pure';
