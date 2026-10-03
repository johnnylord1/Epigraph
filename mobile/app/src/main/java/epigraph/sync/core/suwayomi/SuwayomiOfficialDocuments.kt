package epigraph.sync.core.suwayomi

internal object SuwayomiOfficialDocuments {
    val UPDATE_MANGA = """
        mutation UpdateManga(${'$'}id: Int!, ${'$'}inLibrary: Boolean) {
          updateManga(input: { id: ${'$'}id, patch: { inLibrary: ${'$'}inLibrary } }) {
            manga { id inLibrary }
          }
        }
    """.trimIndent()

    val UPDATE_MANGA_CATEGORIES = """
        mutation UpdateMangaCategories(${ '$' }mangaId: Int!, ${ '$' }addTo: [Int!]!, ${ '$' }removeFrom: [Int!]!) {
          updateMangaCategories(input: {
            id: ${ '$' }mangaId,
            patch: { addToCategories: ${ '$' }addTo, removeFromCategories: ${ '$' }removeFrom }
          }) {
            manga { id }
          }
        }
    """.trimIndent()

    val UPDATE_CHAPTERS_PROGRESS = """
        mutation UpdateChaptersProgress(
          ${ '$' }ids: [Int!]!,
          ${ '$' }isRead: Boolean,
          ${ '$' }isBookmarked: Boolean,
          ${ '$' }lastPageRead: Int
        ) {
          updateChapters(input: {
            ids: ${ '$' }ids,
            patch: {
              isRead: ${ '$' }isRead,
              isBookmarked: ${ '$' }isBookmarked,
              lastPageRead: ${ '$' }lastPageRead
            }
          }) {
            chapters { id isRead isBookmarked lastPageRead }
          }
        }
    """.trimIndent()

    val UPDATE_CATEGORY = """
        mutation UpdateCategory(${ '$' }id: Int!, ${ '$' }name: String) {
          updateCategory(input: { id: ${ '$' }id, patch: { name: ${ '$' }name } }) {
            category { id name order }
          }
        }
    """.trimIndent()

    val DELETE_CATEGORY = """
        mutation DeleteCategory(${ '$' }id: Int!) {
          deleteCategory(input: { categoryId: ${ '$' }id }) {
            category { id }
          }
        }
    """.trimIndent()

    val UPDATE_CATEGORY_ORDER = """
        mutation UpdateCategoryOrder(${ '$' }id: Int!, ${ '$' }position: Int!) {
          updateCategoryOrder(input: { id: ${ '$' }id, position: ${ '$' }position }) {
            categories { id name order }
          }
        }
    """.trimIndent()

    val CONFIRM_CATEGORY = """
        query ConfirmCategory(${ '$' }id: Int!) {
          categories(condition: { id: ${ '$' }id }, first: 1) {
            nodes { id name order }
          }
        }
    """.trimIndent()

    val CONFIRM_MANGA = """
        query ConfirmManga(${ '$' }id: Int!) {
          manga(id: ${ '$' }id) { id inLibrary }
        }
    """.trimIndent()
}
