export const GET_LIBRARY = `
  query GetLibrary {
    mangas(condition: { inLibrary: true }) {
      nodes {
        id
        title
        thumbnailUrl
        realUrl
        inLibrary
        downloadCount
        unreadCount
        chapters {
          totalCount
        }
        status
        genre
        sourceId
        source {
          id
          name
          lang
          displayName
        }
      }
    }
  }
`;

export const GET_CHAPTERS = `
  query GetChapters($mangaId: Int!) {
    chapters(condition: { mangaId: $mangaId }) {
      nodes {
        id
        name
        chapterNumber
        sourceOrder
        isRead
        isDownloaded
        isBookmarked
        pageCount
        mangaId
        uploadDate
        realUrl
        lastPageRead
        scanlator
      }
    }
  }
`;

export const RESTORE_BACKUP = `
  mutation RestoreBackup($backup: Upload!) {
    restoreBackup(input: { backup: $backup }) {
      id
      status {
        mangaProgress
        state
        totalManga
      }
    }
  }
`;

export const GET_RESTORE_STATUS = `
  query RestoreStatus($id: String!) {
    restoreStatus(id: $id) {
      mangaProgress
      state
      totalManga
    }
  }
`;

export const GET_CATEGORIES_SUMMARY = `
  query GetCategoriesSummary {
    categories {
      nodes {
        id
        name
        order
        default
        includeInUpdate
        includeInDownload
      }
    }
  }
`;

export const GET_DOWNLOAD_STATUS = `
  query GetDownloadStatus {
    downloadStatus {
      state
      queue {
        progress
        state
        chapter {
          id
          name
          pageCount
          mangaId
          manga {
            id
            title
            thumbnailUrl
          }
        }
      }
    }
  }
`;

export const UPDATE_EXTENSION = `
  mutation UpdateExtension($id: String!, $install: Boolean, $uninstall: Boolean, $update: Boolean) {
    updateExtension(input: { id: $id, patch: { install: $install, uninstall: $uninstall, update: $update } }) {
      extension {
        apkName
        pkgName
        name
        lang
        versionName
        versionCode
        isInstalled
        isObsolete
        hasUpdate
        iconUrl
        repo
      }
    }
  }
`;

export const GET_TRACKERS = `
  query GetTrackers {
    trackers {
      nodes {
        id
        name
        icon
        isLoggedIn
        authUrl
        supportsPrivateTracking
        scores
        statuses {
          value
          name
        }
      }
    }
  }
`;

export const GET_LIBRARY_TRACKING_SUMMARY = `
  query GetLibraryTrackingSummary {
    trackers {
      nodes {
        id
        isLoggedIn
        statuses {
          value
          name
        }
        trackRecords {
          nodes {
            status
            totalChapters
            manga {
              id
              inLibrary
            }
          }
        }
      }
    }
  }
`;
