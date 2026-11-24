package epigraph.sync.v4

import android.content.Context
import epigraph.sync.core.policy.EffectiveSyncPolicy
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Sync domains and inventory subdomains selected for one V4 run. */
data class V4SyncDomainPolicy(
    val syncComics: Boolean = true,
    val syncNovels: Boolean = true,
    val syncBooks: Boolean = true,
    val reconcileComicRepositories: Boolean = true,
    val reconcileComicExtensions: Boolean = true,
    val reconcileNovelRepositories: Boolean = true,
    val reconcileNovelPlugins: Boolean = true,
) {
    val enabledKeys: Set<String> get() = buildSet {
        if (syncComics) add("comics")
        if (syncNovels) add("novels")
        if (syncBooks) add("books")
        if (reconcileComicRepositories) add("comicRepositories")
        if (reconcileComicExtensions) add("comicExtensions")
        if (reconcileNovelRepositories) add("novelRepositories")
        if (reconcileNovelPlugins) add("novelPlugins")
    }

    val outboxDomains: List<String> get() = buildList {
        if (syncComics) add("comics")
        if (syncNovels) add("novels")
        if (syncBooks) add("books")
        if (reconcileComicRepositories || reconcileComicExtensions || reconcileNovelRepositories || reconcileNovelPlugins) add("extensions")
        if (syncComics || syncNovels) add("preferences")
    }

    fun allows(domain: String, entityType: String, entityKey: String, payload: JsonElement?): Boolean {
        val fields = payload as? JsonObject
        return when (domain) {
            "comics" -> syncComics
            "novels" -> syncNovels
            "books" -> syncBooks
            "preferences" -> when (entityKey.substringBefore(':')) {
                "comic" -> syncComics
                "novel" -> syncNovels
                else -> false
            }
            "extensions" -> {
                val kind = (fields?.get("kind") as? JsonPrimitive)?.contentOrNull ?: entityKey.substringBefore(':')
                when (kind) {
                    "comic" -> when (entityType) {
                        "extension.repo" -> reconcileComicRepositories
                        "extension.installed" -> reconcileComicExtensions
                        else -> false
                    }
                    "novel" -> when (entityType) {
                        "extension.repo" -> reconcileNovelRepositories
                        "extension.installed" -> reconcileNovelPlugins
                        else -> false
                    }
                    else -> false
                }
            }
            else -> false
        }
    }

    fun only(keys: Set<String>) = V4SyncDomainPolicy(
        syncComics = syncComics && "comics" in keys,
        syncNovels = syncNovels && "novels" in keys,
        syncBooks = syncBooks && "books" in keys,
        reconcileComicRepositories = reconcileComicRepositories && "comicRepositories" in keys,
        reconcileComicExtensions = reconcileComicExtensions && "comicExtensions" in keys,
        reconcileNovelRepositories = reconcileNovelRepositories && "novelRepositories" in keys,
        reconcileNovelPlugins = reconcileNovelPlugins && "novelPlugins" in keys,
    )

    companion object {
        fun from(policy: EffectiveSyncPolicy) = V4SyncDomainPolicy(
            syncComics = policy.syncComics,
            syncNovels = policy.syncNovels,
            syncBooks = policy.syncBooks,
            reconcileComicRepositories = policy.reconcileComicRepositories,
            reconcileComicExtensions = policy.reconcileComicExtensions,
            reconcileNovelRepositories = policy.reconcileNovelRepositories,
            reconcileNovelPlugins = policy.reconcileNovelPlugins,
        )
    }
}

/** Stores completed initial-sync domains outside SQLDelight so this needs no schema migration. */
interface V4SyncDomainProgress {
    fun load(serverId: String, profileId: String): Set<String>?
    fun save(serverId: String, profileId: String, domains: Set<String>)
    fun clear(serverId: String)
}

internal class SharedPreferencesV4SyncDomainProgress(context: Context) : V4SyncDomainProgress {
    private val preferences = context.applicationContext.getSharedPreferences("v4_sync_domains", Context.MODE_PRIVATE)
    private fun serverPrefix(serverId: String) = "${serverId.length}:$serverId"
    private fun key(serverId: String, profileId: String) = "${serverPrefix(serverId)}$profileId"
    override fun load(serverId: String, profileId: String): Set<String>? = preferences.getString(key(serverId, profileId), null)
        ?.split(',')?.filter(String::isNotBlank)?.toSet()
    override fun save(serverId: String, profileId: String, domains: Set<String>) {
        preferences.edit().putString(key(serverId, profileId), domains.sorted().joinToString(",")).apply()
    }
    override fun clear(serverId: String) {
        val prefix = serverPrefix(serverId)
        val editor = preferences.edit()
        for (k in preferences.all.keys) {
            if (k.startsWith(prefix)) editor.remove(k)
        }
        editor.apply()
    }
}

internal class MemoryV4SyncDomainProgress : V4SyncDomainProgress {
    private val values = mutableMapOf<Pair<String, String>, Set<String>>()
    override fun load(serverId: String, profileId: String) = values[serverId to profileId]
    override fun save(serverId: String, profileId: String, domains: Set<String>) { values[serverId to profileId] = domains.toSet() }
    override fun clear(serverId: String) {
        values.keys.removeAll { it.first == serverId }
    }
}
