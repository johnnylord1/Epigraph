package eu.kanade.tachiyomi.core.preference

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class InMemoryPreferenceStore : PreferenceStore {
    private val values = mutableMapOf<String, Any?>()

    override fun getString(key: String, defaultValue: String) = preference(key, defaultValue)
    override fun getLong(key: String, defaultValue: Long) = preference(key, defaultValue)
    override fun getInt(key: String, defaultValue: Int) = preference(key, defaultValue)
    override fun getFloat(key: String, defaultValue: Float) = preference(key, defaultValue)
    override fun getBoolean(key: String, defaultValue: Boolean) = preference(key, defaultValue)
    override fun getStringSet(key: String, defaultValue: Set<String>) = preference(key, defaultValue)
    override fun <T> getObject(
        key: String,
        defaultValue: T,
        serializer: (T) -> String,
        deserializer: (String) -> T,
    ) = preference(key, defaultValue)

    override fun getAll(): Map<String, *> = values.toMap()

    private fun <T> preference(key: String, defaultValue: T): Preference<T> =
        InMemoryPreference(key, defaultValue, values)
}

private class InMemoryPreference<T>(
    private val preferenceKey: String,
    private val fallback: T,
    private val values: MutableMap<String, Any?>,
) : Preference<T> {
    private val state = MutableStateFlow(get())

    override fun key() = preferenceKey

    @Suppress("UNCHECKED_CAST")
    override fun get(): T = values[preferenceKey] as? T ?: fallback

    override fun set(value: T) {
        values[preferenceKey] = value
        state.value = value
    }

    override fun isSet() = preferenceKey in values

    override fun delete() {
        values.remove(preferenceKey)
        state.value = fallback
    }

    override fun defaultValue() = fallback
    override fun changes(): Flow<T> = state
    override fun stateIn(scope: CoroutineScope): StateFlow<T> = state
}
