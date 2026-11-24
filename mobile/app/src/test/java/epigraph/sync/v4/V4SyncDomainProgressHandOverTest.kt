package epigraph.sync.v4

import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, manifest = Config.NONE)
@ConscryptMode(ConscryptMode.Mode.OFF)
class V4SyncDomainProgressHandOverTest {

    @Test
    fun handOverKeepsTheNewCoreProgressAndDropsTheOthers() {
        val progress = SharedPreferencesV4SyncDomainProgress(RuntimeEnvironment.getApplication())
        progress.save("srv-new", "main", setOf("comics", "novels"))
        progress.save("srv-old", "main", setOf("comics"))
        // A server id that extends the kept one must not survive by prefix alone.
        progress.save("srv-new2", "main", setOf("books"))

        progress.clearExcept("srv-new")

        assertEquals(setOf("comics", "novels"), progress.load("srv-new", "main"))
        assertNull(progress.load("srv-old", "main"))
        assertNull(progress.load("srv-new2", "main"))
    }
}
