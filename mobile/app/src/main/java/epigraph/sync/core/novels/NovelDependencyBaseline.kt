package epigraph.sync.core.novels

/** A repository or plugin this device and the Core both held, with the local key it maps to. */
data class NovelDependencyBaselineEntry(
    val entityId: String,
    val kind: Kind,
    /** Canonical URL for a repository, plugin id for a plugin. */
    val key: String,
) {
    enum class Kind { REPOSITORY, PLUGIN }
}

/**
 * The repositories and plugins this device and the Core last agreed on, per scope.
 *
 * It tells a change apart from a first meeting: a declaration missing here that is in the
 * baseline was removed here, and a Core tombstone for a baseline entry was removed on the other
 * device. Anything outside the baseline is only ever added, never removed.
 */
interface NovelDependencyBaseline {
    fun read(scopeId: String): Map<String, NovelDependencyBaselineEntry>
    fun write(scopeId: String, entries: Collection<NovelDependencyBaselineEntry>)
}

class InMemoryNovelDependencyBaseline : NovelDependencyBaseline {
    private val scopes = mutableMapOf<String, Map<String, NovelDependencyBaselineEntry>>()

    override fun read(scopeId: String): Map<String, NovelDependencyBaselineEntry> = scopes[scopeId].orEmpty()

    override fun write(scopeId: String, entries: Collection<NovelDependencyBaselineEntry>) {
        scopes[scopeId] = entries.associateBy(NovelDependencyBaselineEntry::entityId)
    }
}

class SharedPreferencesNovelDependencyBaseline(context: android.content.Context) : NovelDependencyBaseline {
    private val preferences =
        context.getSharedPreferences("epigraph_core_novel_dependency_baseline", android.content.Context.MODE_PRIVATE)

    override fun read(scopeId: String): Map<String, NovelDependencyBaselineEntry> =
        preferences.getStringSet(scopeId, null).orEmpty()
            .mapNotNull(::decode)
            .associateBy(NovelDependencyBaselineEntry::entityId)

    override fun write(scopeId: String, entries: Collection<NovelDependencyBaselineEntry>) {
        preferences.edit().putStringSet(scopeId, entries.mapTo(mutableSetOf(), ::encode)).apply()
    }

    private fun encode(entry: NovelDependencyBaselineEntry): String =
        listOf(entry.kind.name, entry.entityId, entry.key).joinToString(SEPARATOR)

    private fun decode(value: String): NovelDependencyBaselineEntry? {
        val parts = value.split(SEPARATOR)
        if (parts.size != 3 || parts.any(String::isEmpty)) return null
        val kind = NovelDependencyBaselineEntry.Kind.entries.firstOrNull { it.name == parts[0] } ?: return null
        return NovelDependencyBaselineEntry(entityId = parts[1], kind = kind, key = parts[2])
    }

    private companion object {
        const val SEPARATOR = "\u0000"
    }
}
