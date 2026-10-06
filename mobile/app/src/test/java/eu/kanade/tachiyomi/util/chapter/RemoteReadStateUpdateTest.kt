package eu.kanade.tachiyomi.util.chapter

import eu.kanade.tachiyomi.data.database.models.Chapter
import eu.kanade.tachiyomi.source.model.SChapter
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class RemoteReadStateUpdateTest {

    @Test
    fun `a chapter read remotely is marked read here`() {
        val update = remoteReadStateUpdate(local(read = false, lastPageRead = 0), remote(read = true, lastPageRead = 12))

        assertEquals(7L, update?.id)
        assertEquals(true, update?.read)
        assertEquals(12L, update?.lastPageRead)
    }

    @Test
    fun `remote page progress only moves forward`() {
        val update = remoteReadStateUpdate(local(read = false, lastPageRead = 3), remote(read = false, lastPageRead = 9))

        assertNull(update?.read)
        assertEquals(9L, update?.lastPageRead)
        assertNull(remoteReadStateUpdate(local(read = false, lastPageRead = 9), remote(read = false, lastPageRead = 3)))
    }

    @Test
    fun `a chapter read here is never un-read by the source`() {
        assertNull(remoteReadStateUpdate(local(read = true, lastPageRead = 20), remote(read = false, lastPageRead = 0)))
    }

    @Test
    fun `an unread source chapter changes nothing`() {
        assertNull(remoteReadStateUpdate(local(read = false, lastPageRead = 0), remote(read = false, lastPageRead = 0)))
    }

    private fun local(read: Boolean, lastPageRead: Int) = Chapter.create().apply {
        id = 7
        url = "aethon-core://suwayomi/server/main/chapter/1"
        name = "Chapter 1"
        this.read = read
        last_page_read = lastPageRead
    }

    private fun remote(read: Boolean, lastPageRead: Int) = SChapter.create().apply {
        url = "aethon-core://suwayomi/server/main/chapter/1"
        name = "Chapter 1"
        this.read = read
        last_page_read = lastPageRead
    }
}
