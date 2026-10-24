package eu.kanade.tachiyomi.ui.main

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.ViewPropertyAnimator
import android.widget.FrameLayout
import androidx.core.view.isVisible
import com.bluelinelabs.conductor.Controller
import com.bluelinelabs.conductor.ControllerChangeHandler
import com.bluelinelabs.conductor.ControllerChangeType
import com.bluelinelabs.conductor.Router
import com.bluelinelabs.conductor.RouterTransaction
import com.bluelinelabs.conductor.changehandler.SimpleSwapChangeHandler
import epigraph.recommendations.ui.DiscoverController
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.ui.library.LibraryController
import eu.kanade.tachiyomi.ui.library.compose.LibraryComposeController
import eu.kanade.tachiyomi.ui.recents.RecentsController
import eu.kanade.tachiyomi.ui.source.BrowseController
import yokai.util.koin.injectLazy
import yokai.domain.base.BasePreferences
import yokai.presentation.theme.Motion
import yokai.presentation.theme.ReducedMotion

/**
 * Contract implemented by controllers that can sit at the root of a [RootTabsController]
 * tab. The hooks fire on tab swap — when the user taps a different bottom-nav item — and
 * give the outgoing/incoming controllers a chance to release/acquire ownership of the
 * shared activity chrome (toolbar mode, app-bar Y, tab strip binding, scroll wiring).
 *
 * These hooks are NOT Conductor lifecycle events: nothing is pushed or popped. The view
 * stays attached and the controller is never destroyed by a tab swap. For real Conductor
 * pushes within a tab (e.g. MangaDetails on top of Library), the controller's own
 * `onChangeStarted(PUSH_ENTER/EXIT)` continues to handle them — those are independent of
 * tab activation.
 */
interface RootTabContent {
    /** This controller has just become the visible tab. */
    fun onTabActivated() {}

    /** This controller is no longer the visible tab (another tab took over). */
    fun onTabDeactivated() {}
}

/**
 * Single persistent root controller that hosts Library / Discover / Recents / Browse simultaneously
 * in sibling FrameLayouts. Tab swaps just toggle container visibility — the child
 * controllers are never destroyed by switching tabs, so subsequent visits skip the
 * inflate + layout work entirely. Inflation is deferred per tab: the child router for a
 * given tab is only initialised the first time the user actually selects it.
 *
 * Per-tab back-stack: pushing MangaDetails (or any controller) from inside a tab pushes
 * onto that tab's child router. Switching tabs and returning preserves the pushed stack.
 *
 * Tab activation is communicated to the root controllers via [RootTabContent] — no
 * synthetic Conductor events are dispatched.
 */
class RootTabsController : Controller() {

    private val basePreferences: BasePreferences by injectLazy()

    private val containers = mutableMapOf<Int, FrameLayout>()

    // -1 sentinel until selectTab() is first called. Prevents premature visibility
    // assignment in onCreateView from showing an empty Library container before the host
    // activity has decided which startingTab to use.
    var currentTabId: Int = -1
        private set

    // False until the visible tab has been told it is active since this host's view was created.
    private var visibleTabActivated = false

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup,
        savedViewState: Bundle?,
    ): View {
        val ctx = activity!!
        val root = FrameLayout(ctx)
        visibleTabActivated = false
        if (savedViewState != null) {
            currentTabId = savedViewState.getInt(KEY_CURRENT_TAB, currentTabId)
        }
        for (tabId in TAB_IDS) {
            val tabContainer = FrameLayout(ctx).apply {
                id = tabContainerId(tabId)
                isVisible = (currentTabId == tabId)
            }
            root.addView(
                tabContainer,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
            containers[tabId] = tabContainer
        }

        // Rebind child routers to their new containers
        for (tabId in TAB_IDS) {
            if (tabId == currentTabId) {
                ensureChildRoot(tabId)
            } else {
                val tabContainer = containers[tabId]!!
                val childRouter = getChildRouter(tabContainer, childRouterTag(tabId))
                (activity as? MainActivity)?.registerControllerChangeListener(childRouter)
            }
        }

        return root
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        currentTabId = savedInstanceState.getInt(KEY_CURRENT_TAB, currentTabId)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt(KEY_CURRENT_TAB, currentTabId)
    }

    /**
     * Conductor does not forward change events to child routers, so a controller pushed over the
     * whole tab host (onboarding) would leave the visible tab believing it is still active while
     * covered, and never re-activated once it pops. The host view may even be recreated on pop,
     * which resets the tab's activation state; re-activate it explicitly. This runs when the
     * change starts so a deferred library update is drawn before the covering screen fades out.
     */
    override fun onChangeStarted(handler: ControllerChangeHandler, type: ControllerChangeType) {
        super.onChangeStarted(handler, type)
        val current = currentTabId.takeIf { it != -1 } ?: return
        val top = childRouterFor(current)?.backstack?.lastOrNull()?.controller as? RootTabContent
        when (type) {
            ControllerChangeType.POP_ENTER -> top?.onTabActivated()
            ControllerChangeType.PUSH_EXIT -> top?.onTabDeactivated()
            else -> Unit
        }
    }

    override fun onDestroyView(view: View) {
        cancelSwapAnimations()
        containers.clear()
        super.onDestroyView(view)
    }

    /**
     * Make [tabId] the visible tab. Lazy-creates the tab's child router and root
     * controller on first selection. Idempotent — no-op when already on [tabId].
     *
     * Sequence:
     *  1. Notify the outgoing tab's top controller via [RootTabContent.onTabDeactivated] (if any).
     *  2. Hide the outgoing container, show the incoming.
     *  3. Materialise the incoming child router (first selection only — Conductor's
     *     PUSH_ENTER fires synchronously here on the controller).
     *  4. Notify the incoming controller via [RootTabContent.onTabActivated]. The controller
     *     calls its own [BaseController.onSetupLocalChrome] to wire its local appBar — this fires
     *     for both initial creation AND tab swap, since the chrome state has to be applied
     *     either way.
     *  5. Ask [MainActivity] to resync any remaining cross-cutting state (title, etc.).
     */
    fun selectTab(tabId: Int) {
        if (!containers.containsKey(tabId)) return
        val prev = currentTabId
        if (tabId == prev && containers[tabId]?.isVisible == true) {
            // Already visible — make sure the child router has a root in case the activity
            // recreated us empty (defensive).
            ensureChildRoot(tabId)
            // A recreated host (theme or configuration change, process restore) brings the tab
            // back without a swap. Activate it once, or Library stays paused with stale items
            // and no chrome until the user switches tabs or restarts the app.
            if (!visibleTabActivated) {
                visibleTabActivated = true
                (childRouterFor(tabId)?.backstack?.lastOrNull()?.controller as? RootTabContent)?.onTabActivated()
            }
            return
        }
        val outgoing = if (prev != -1 && prev != tabId) {
            childRouterFor(prev)?.backstack?.lastOrNull()?.controller
        } else {
            null
        }
        (outgoing as? RootTabContent)?.onTabDeactivated()

        val outgoingContainer = if (prev != -1) containers[prev] else null
        val target = containers[tabId] ?: return
        currentTabId = tabId
        ensureChildRoot(tabId)

        val incoming = childRouterFor(tabId)?.backstack?.lastOrNull()?.controller
        visibleTabActivated = true
        (incoming as? RootTabContent)?.onTabActivated()

        (activity as? MainActivity)?.onActiveTabChanged(prev, tabId)
        animateSwap(outgoingContainer, target)
    }

    /**
     * Fade through (DESIGN.md §9) from the outgoing tab to the incoming one, then mark the outgoing tab GONE
     * so its view tree drops out of measure/layout passes.
     *
     * Honors [ReducedMotion.isEnabled] — snaps to the end state without an animator when
     * the user has opted into reduced motion (Appearance → Motion preference).
     *
     * Cancels any prior in-flight swap so rapid taps don't stack animators.
     */
    private fun animateSwap(outgoing: FrameLayout?, incoming: FrameLayout) {
        cancelSwapAnimations()

        if (ReducedMotion.isEnabled() || outgoing == null) {
            // No previous tab to fade out from (initial selection) or reduced motion — snap.
            settleSwap()
            return
        }

        containers.values.forEach { container ->
            if (container !== outgoing && container !== incoming) {
                container.isVisible = false
                container.alpha = 0f
                resetTransform(container)
            }
        }

        incoming.isVisible = true
        outgoing.isVisible = true
        incoming.bringToFront()

        // Animate render properties through ViewPropertyAnimator so the RenderThread can
        // drive the transition. The previous ValueAnimator ran a Kotlin callback on the UI
        // thread every frame and invalidated two complete RecyclerView/Compose trees.
        // Always establish a fresh start state. A rapid retap can make the destination one of
        // the two containers from the cancelled transition; reusing its partial alpha/scale
        // made the next motion start halfway through or appear to snap.
        incoming.alpha = 0f
        incoming.translationX = 0f
        incoming.scaleX = Motion.FadeThroughScale
        incoming.scaleY = Motion.FadeThroughScale

        val generation = ++swapGeneration
        activeOutgoing = outgoing
        activeIncoming = incoming

        // Material "fade through": the containers have transparent backgrounds, so fading the
        // incoming tab over an opaque outgoing one superimposed both app bars, titles and lists
        // for the whole transition. The outgoing tab now fades out first and the incoming tab
        // fades/slides in after it, so the two screens are never drawn on top of each other.
        // DESIGN.md §9: out in dur-instant, in with alpha + scale 0.94→1 for the rest of dur-standard.
        outgoing.alpha = 1f
        resetTransform(outgoing)
        outgoingAnimator = outgoing.animate()
            .alpha(0f)
            .setStartDelay(0L)
            .setDuration(Motion.DurInstant.toLong())
            .setInterpolator(Motion.Interpolators.Exit)
            .withLayer()

        incomingAnimator = incoming.animate()
            .alpha(1f)
            .scaleX(1f)
            .scaleY(1f)
            .setStartDelay(Motion.DurInstant.toLong())
            .setDuration((Motion.DurStandard - Motion.DurInstant).toLong())
            .setInterpolator(Motion.Interpolators.Enter)
            .withLayer()
            .setListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    if (generation != swapGeneration) return
                    settleSwap()
                }
            })

        outgoingAnimator?.start()
        incomingAnimator?.start()
    }

    private fun resetTransform(container: View) {
        container.translationX = 0f
        container.scaleX = 1f
        container.scaleY = 1f
    }

    private fun cancelSwapAnimations() {
        ++swapGeneration
        outgoingAnimator?.setListener(null)?.cancel()
        incomingAnimator?.setListener(null)?.cancel()
        activeOutgoing?.alpha = 1f
        activeIncoming?.alpha = 1f
        activeOutgoing?.let(::resetTransform)
        activeIncoming?.let(::resetTransform)
        outgoingAnimator = null
        incomingAnimator = null
        activeOutgoing = null
        activeIncoming = null
    }

    private fun settleSwap() {
        containers.forEach { (tabId, container) ->
            val selected = tabId == currentTabId
            container.animate().setListener(null).setStartDelay(0L).cancel()
            container.alpha = if (selected) 1f else 0f
            resetTransform(container)
            container.isVisible = selected
        }
        outgoingAnimator = null
        incomingAnimator = null
        activeOutgoing = null
        activeIncoming = null
        (activity as? MainActivity)?.onRootTabTransitionSettled()
    }

    private var swapGeneration = 0
    private var outgoingAnimator: ViewPropertyAnimator? = null
    private var incomingAnimator: ViewPropertyAnimator? = null
    private var activeOutgoing: FrameLayout? = null
    private var activeIncoming: FrameLayout? = null

    private fun childRouterFor(tabId: Int): Router? {
        val container = containers[tabId] ?: return null
        return getChildRouter(container, childRouterTag(tabId))
    }

    /**
     * The child router for the currently visible tab. Returns null only if the view tree
     * is not yet created.
     */
    fun activeChildRouter(): Router? {
        val container = containers[currentTabId] ?: return null
        return getChildRouter(container, childRouterTag(currentTabId))
    }

    private fun ensureChildRoot(tabId: Int) {
        val container = containers[tabId] ?: return
        val childRouter = getChildRouter(container, childRouterTag(tabId))
        // Wire the host activity's change listener onto this child router so that pushes
        // and pops within this tab fire syncActivityViewWithController, nav-icon updates,
        // bottom-nav alpha, etc. Idempotent in the host.
        (activity as? MainActivity)?.registerControllerChangeListener(childRouter)
        if (!childRouter.hasRootController()) {
            val controller = controllerForTab(tabId)
            childRouter.setRoot(
                RouterTransaction.with(controller)
                    .pushChangeHandler(SimpleSwapChangeHandler(false))
                    .popChangeHandler(SimpleSwapChangeHandler(false))
                    .tag(tabId.toString()),
            )
        }
    }

    /**
     * All currently-materialised child routers (one per tab the user has visited).
     * Used by [MainActivity] to attach its change listener on startup for tabs already
     * restored from saved state.
     */
    fun allChildRouters(): List<Router> = TAB_IDS.mapNotNull { childRouterFor(it) }

    private fun controllerForTab(id: Int): Controller = when (id) {
        R.id.nav_library ->
            if (basePreferences.composeLibrary().get()) LibraryComposeController() else LibraryController()
        R.id.nav_discover -> DiscoverController()
        R.id.nav_recents -> RecentsController()
        else -> BrowseController()
    }

    fun resetActiveTabAlpha() {
        containers[currentTabId]?.let { container ->
            container.alpha = 1f
            container.isVisible = true
        }
    }

    override fun handleBack(): Boolean = activeChildRouter()?.handleBack() == true

    private fun childRouterTag(tabId: Int): String = "root_tabs_child_$tabId"

    private fun tabContainerId(navId: Int): Int = when (navId) {
        R.id.nav_library -> CONTAINER_ID_LIBRARY
        R.id.nav_discover -> CONTAINER_ID_DISCOVER
        R.id.nav_recents -> CONTAINER_ID_RECENTS
        else -> CONTAINER_ID_BROWSE
    }

    companion object {
        private const val KEY_CURRENT_TAB = "RootTabsController.currentTabId"
        // Stable container ids so Conductor's child router restores into the same FrameLayout
        // across config changes. Picked from the 0x7E_xx_xxxx custom-id range to avoid R clash.
        private const val CONTAINER_ID_LIBRARY = 0x7E001001
        private const val CONTAINER_ID_RECENTS = 0x7E001002
        private const val CONTAINER_ID_BROWSE = 0x7E001003
        private const val CONTAINER_ID_DISCOVER = 0x7E001004
        private val TAB_IDS = listOf(R.id.nav_library, R.id.nav_discover, R.id.nav_recents, R.id.nav_browse)
    }
}
