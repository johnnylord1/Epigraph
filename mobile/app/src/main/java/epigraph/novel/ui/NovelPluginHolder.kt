package epigraph.novel.ui

import android.animation.AnimatorInflater
import android.content.res.ColorStateList
import android.graphics.Color
import android.view.View
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import coil3.asImage
import coil3.dispose
import coil3.load
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.coil.CoverViewTarget
import eu.kanade.tachiyomi.databinding.ExtensionCardItemBinding
import eu.kanade.tachiyomi.ui.base.holder.BaseFlexibleViewHolder
import eu.kanade.tachiyomi.util.system.getResourceColor
import eu.kanade.tachiyomi.util.view.resetStrokeColor
import eu.kanade.tachiyomi.util.view.setText
import yokai.i18n.MR
import yokai.util.lang.getString
import java.util.Locale

/**
 * Holder for a novel plugin item in the browse bottom sheet.
 * Reuses ExtensionCardItemBinding (same layout as manga extensions).
 */
class NovelPluginHolder(view: View, val adapter: NovelPluginAdapter) :
    BaseFlexibleViewHolder(view, adapter) {

    private val binding = ExtensionCardItemBinding.bind(view)

    init {
        binding.extButton.setOnClickListener {
            adapter.listener.onNovelPluginButtonClick(flexibleAdapterPosition)
        }
        binding.cancelButton.isVisible = false
        // Manga extension icons carry their own transparent margin; LNReader icons are full-bleed,
        // so they get a wider inset to draw at the same visible size.
        val inset = itemView.resources.getDimensionPixelSize(R.dimen.novel_plugin_icon_inset)
        binding.sourceImage.setPadding(inset, inset, inset, inset)
    }

    fun bind(item: NovelPluginItem) {
        val plugin = item.plugin

        binding.extTitle.text = plugin.name
        binding.version.text = plugin.version
        binding.lang.text = plugin.lang
        binding.lang.isVisible = true
        binding.date.isVisible = false
        binding.warning.text = when {
            item.isObsolete -> itemView.context.getString(MR.strings.obsolete).uppercase(Locale.ROOT)
            else -> ""
        }
        binding.installProgress.isVisible = item.isInstalling
        binding.cancelButton.isVisible = false

        binding.sourceImage.dispose()
        // Prefer the on-disk icon when present (#10). The book placeholder keeps the row
        // populated for the first paint frame while Coil resolves either the File or URL.
        val placeholderImage = ContextCompat.getDrawable(itemView.context, R.drawable.ic_book_24dp)?.asImage()
        when {
            !plugin.iconUrl.isNullOrBlank() -> {
                binding.sourceImage.load(plugin.iconUrl) {
                    target(CoverViewTarget(binding.sourceImage))
                    placeholderImage?.let {
                        placeholder(it)
                        error(it)
                    }
                }
            }
            else -> binding.sourceImage.setImageResource(R.drawable.ic_book_24dp)
        }

        bindButton(item)
    }

    private fun bindButton(item: NovelPluginItem) = with(binding.extButton) {
        isEnabled = !item.isInstalling
        isClickable = !item.isInstalling
        isActivated = false
        strokeColor = ColorStateList.valueOf(Color.TRANSPARENT)
        rippleColor = ColorStateList.valueOf(context.getResourceColor(android.R.attr.colorControlHighlight))
        stateListAnimator = null

        when {
            item.isInstalling -> {
                setText(MR.strings.installing)
                isEnabled = false
            }
            item.hasUpdate -> {
                isActivated = true
                stateListAnimator = AnimatorInflater.loadStateListAnimator(context, R.animator.icon_btn_state_list_anim)
                rippleColor = ColorStateList.valueOf(context.getColor(R.color.on_secondary_highlight))
                setText(MR.strings.update)
            }
            item.isInstalled -> setText(MR.strings.settings)
            else -> {
                resetStrokeColor()
                setText(MR.strings.install)
            }
        }
    }
}
