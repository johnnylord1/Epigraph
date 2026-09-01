export const MIHON_BACKUP_PROTO = `
syntax = "proto3";

message Backup {
  repeated BackupManga backupManga = 1;
  repeated BackupSource backupSources = 101;
  repeated BackupExtensionStore backupExtensionStores = 106;
}

message BackupSource {
  string name = 1;
  int64 sourceId = 2;
}

message BackupExtensionStore {
  string indexUrl = 1;
  string name = 2;
  string badgeLabel = 3;
  string contactWebsite = 4;
  string signingKey = 5;
  string contactDiscord = 6;
  bool isLegacy = 7;
  string extensionListUrl = 8;
}

message BackupManga {
  int64 source = 1;
  string url = 2;
  string title = 3;
  string artist = 4;
  string author = 5;
  string description = 6;
  repeated string genre = 7;
  int32 status = 8;
  string thumbnailUrl = 9;
  int64 dateAdded = 13;
  int32 viewer = 14;
  repeated BackupChapter chapters = 16;
  repeated int64 categories = 17;
  repeated BackupTracking tracking = 18;
  bool favorite = 100;
  int32 chapterFlags = 101;
  int32 viewer_flags = 103;
  repeated BackupHistory history = 104;
  int32 updateStrategy = 105;
  int64 lastModifiedAt = 106;
  int64 favoriteModifiedAt = 107;
  repeated string excludedScanlators = 108;
  int64 version = 109;
  string notes = 110;
  bool initialized = 111;
  // Fork-dependent: bytes in Mihon/Yokai, string in J2K. It is intentionally
  // left unknown so the reconciliation layer preserves the original wire data.
  int32 customStatus = 602;
  string customTitle = 800;
  string customArtist = 801;
  string customAuthor = 802;
  string customDescription = 804;
  repeated string customGenre = 805;
}

message BackupChapter {
  string url = 1;
  string name = 2;
  string scanlator = 3;
  bool read = 4;
  bool bookmark = 5;
  int64 lastPageRead = 6;
  int64 dateFetch = 7;
  int64 dateUpload = 8;
  float chapterNumber = 9;
  int64 sourceOrder = 10;
  int64 lastModifiedAt = 11;
  int64 version = 12;
}

message BackupTracking {
  int32 syncId = 1;
  int64 libraryId = 2;
  int32 mediaIdInt = 3;
  string trackingUrl = 4;
  string title = 5;
  float lastChapterRead = 6;
  int32 totalChapters = 7;
  float score = 8;
  int32 status = 9;
  int64 startedReadingDate = 10;
  int64 finishedReadingDate = 11;
  bool private = 12;
  int64 mediaId = 100;
}

message BackupHistory {
  string url = 1;
  int64 lastRead = 2;
  int64 readDuration = 3;
}
`;
