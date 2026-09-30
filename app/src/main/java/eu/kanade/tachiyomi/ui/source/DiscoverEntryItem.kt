package eu.kanade.tachiyomi.ui.source

import android.view.View
import androidx.recyclerview.widget.RecyclerView
import eu.davidea.flexibleadapter.FlexibleAdapter
import eu.davidea.flexibleadapter.items.AbstractFlexibleItem
import eu.davidea.flexibleadapter.items.IFlexible
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.databinding.BrowseDiscoverItemBinding
import eu.kanade.tachiyomi.ui.base.holder.BaseFlexibleViewHolder
import yokai.i18n.MR
import yokai.util.lang.getString

/** Scrollable Browse header that opens the library-based Discover recommendations. */
class DiscoverEntryItem(
    val type: BrowseSourceType,
    private val onClick: (BrowseSourceType) -> Unit,
) : AbstractFlexibleItem<DiscoverEntryItem.Holder>() {

    override fun getLayoutRes(): Int = R.layout.browse_discover_item

    override fun isSwipeable(): Boolean = false

    override fun isDraggable(): Boolean = false

    override fun createViewHolder(view: View, adapter: FlexibleAdapter<IFlexible<RecyclerView.ViewHolder>>) =
        Holder(view, adapter)

    override fun bindViewHolder(
        adapter: FlexibleAdapter<IFlexible<RecyclerView.ViewHolder>>,
        holder: Holder,
        position: Int,
        payloads: MutableList<Any>,
    ) {
        val context = holder.itemView.context
        holder.binding.discoverTitle.text = context.getString(MR.strings.discover_card_title)
        holder.binding.discoverSubtitle.text = context.getString(
            if (type == BrowseSourceType.Novel) MR.strings.discover_card_subtitle_novels else MR.strings.discover_card_subtitle_comics,
        )
        holder.binding.discoverCard.setOnClickListener { onClick(type) }
    }

    override fun equals(other: Any?): Boolean = other is DiscoverEntryItem && other.type == type

    override fun hashCode(): Int = type.hashCode()

    class Holder(view: View, adapter: FlexibleAdapter<IFlexible<RecyclerView.ViewHolder>>) :
        BaseFlexibleViewHolder(view, adapter) {
        val binding = BrowseDiscoverItemBinding.bind(view)
    }
}
