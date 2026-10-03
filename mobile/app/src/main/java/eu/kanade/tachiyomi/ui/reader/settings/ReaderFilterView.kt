package eu.kanade.tachiyomi.ui.reader.settings

import android.content.Context
import android.util.AttributeSet
import android.view.Window
import android.view.WindowManager
import androidx.annotation.ColorInt
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.core.preference.Preference
import eu.kanade.tachiyomi.databinding.ReaderColorFilterBinding
import eu.kanade.tachiyomi.ui.reader.ReaderActivity
import eu.kanade.tachiyomi.util.bindToPreference
import eu.kanade.tachiyomi.widget.BaseReaderSettingsView
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.sample
import yokai.presentation.theme.YokaiTheme

class ReaderFilterView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) :
    BaseReaderSettingsView<ReaderColorFilterBinding>(context, attrs) {

    var window: Window? = null

    // Compose state — recomposition triggers when these change
    private var colorAlpha by mutableFloatStateOf(0f)
    private var colorRed by mutableFloatStateOf(0f)
    private var colorGreen by mutableFloatStateOf(0f)
    private var colorBlue by mutableFloatStateOf(0f)
    private var filterEnabled by mutableStateOf(false)
    private var brightnessValue by mutableFloatStateOf(0f)
    private var brightnessEnabled by mutableStateOf(false)

    override fun inflateBinding() = ReaderColorFilterBinding.bind(this)

    override fun initGeneralPreferences() {
        activity = context as? ReaderActivity ?: return

        colorFilterPref().changes()
            .onEach { setColorFilter(it) }
            .launchIn(activity.scope)

        colorFilterModePref().changes()
            .onEach { setColorFilter(colorFilterPref().get()) }
            .launchIn(activity.scope)

        customBrightnessPref().changes()
            .onEach { setCustomBrightness(it) }
            .launchIn(activity.scope)

        binding.grayscale.bindToPreference(grayscalePref())
        binding.invertedColors.bindToPreference(invertedColorsPref())

        // Set initial values
        setValues(colorFilterValuePref().get())
        brightnessValue = customBrightnessValuePref().get().toFloat()
        filterEnabled = colorFilterPref().get()
        brightnessEnabled = customBrightnessPref().get()

        binding.switchColorFilter.isChecked = filterEnabled
        binding.switchColorFilter.setOnCheckedChangeListener { _, isChecked ->
            colorFilterPref().set(isChecked)
        }

        binding.customBrightness.isChecked = brightnessEnabled
        binding.customBrightness.setOnCheckedChangeListener { _, isChecked ->
            customBrightnessPref().set(isChecked)
        }

        binding.colorFilterMode.bindToPreference(colorFilterModePref())

        // Color filter sliders (A, R, G, B) — Compose
        binding.colorSlidersCompose.setContent {
            YokaiTheme {
                val rgbEnabled = colorAlpha > 0f && filterEnabled
                Column(modifier = Modifier.fillMaxWidth()) {
                    ColorSliderRow(
                        label = "A",
                        value = colorAlpha,
                        enabled = filterEnabled,
                        onValueChange = {
                            colorAlpha = it
                            setColorValue(it.roundToInt(), ALPHA_MASK, 24)
                        },
                    )
                    ColorSliderRow(
                        label = "R",
                        value = colorRed,
                        enabled = rgbEnabled,
                        onValueChange = {
                            colorRed = it
                            setColorValue(it.roundToInt(), RED_MASK, 16)
                        },
                    )
                    ColorSliderRow(
                        label = "G",
                        value = colorGreen,
                        enabled = rgbEnabled,
                        onValueChange = {
                            colorGreen = it
                            setColorValue(it.roundToInt(), GREEN_MASK, 8)
                        },
                    )
                    ColorSliderRow(
                        label = "B",
                        value = colorBlue,
                        enabled = rgbEnabled,
                        onValueChange = {
                            colorBlue = it
                            setColorValue(it.roundToInt(), BLUE_MASK, 0)
                        },
                    )
                }
            }
        }

        // Brightness slider — Compose
        binding.brightnessSliderCompose.setContent {
            YokaiTheme {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 2.dp),
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_brightness_day_24dp),
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(24.dp),
                    )
                    Slider(
                        value = brightnessValue,
                        onValueChange = {
                            brightnessValue = it
                            customBrightnessValuePref().set(it.roundToInt())
                        },
                        valueRange = -75f..100f,
                        enabled = brightnessEnabled,
                        modifier = Modifier
                            .weight(1f)
                            .padding(horizontal = 8.dp),
                    )
                    Text(
                        text = brightnessValue.roundToInt().toString(),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.width(36.dp),
                    )
                }
            }
        }
    }

    private fun setColorFilter(enabled: Boolean) {
        filterEnabled = enabled
        if (enabled) {
            colorFilterValuePref().changes()
                .sample(100)
                .onEach { setColorFilterValue(it) }
                .launchIn(activity.scope)
        }
    }

    private fun setCustomBrightness(enabled: Boolean) {
        brightnessEnabled = enabled
        if (enabled) {
            customBrightnessValuePref().changes()
                .sample(100)
                .onEach { setCustomBrightnessValue(it) }
                .launchIn(activity.scope)
        } else {
            setCustomBrightnessValue(0, true)
        }
    }

    fun setWindowBrightness() {
        setCustomBrightnessValue(
            customBrightnessValuePref().get(),
            !customBrightnessPref().get(),
        )
    }

    private fun setCustomBrightnessValue(value: Int, isDisabled: Boolean = false) {
        if (!isDisabled) {
            brightnessValue = value.toFloat()
            window?.attributes = window?.attributes?.apply {
                screenBrightness = max(0.01f, value / 100f)
            }
        } else {
            window?.attributes = window?.attributes?.apply {
                screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            }
        }
    }

    private fun setColorFilterValue(@ColorInt color: Int) {
        setValues(color)
    }

    private fun setValues(color: Int) {
        colorAlpha = getAlphaFromColor(color).toFloat()
        colorRed = getRedFromColor(color).toFloat()
        colorGreen = getGreenFromColor(color).toFloat()
        colorBlue = getBlueFromColor(color).toFloat()
    }

    fun setColorValue(color: Int, mask: Long, bitShift: Int) {
        val currentColor = colorFilterValuePref().get()
        val updatedColor = (color shl bitShift) or (currentColor and mask.inv().toInt())
        colorFilterValuePref().set(updatedColor)
    }

    private fun isNovelDomain(): Boolean = ReadingModeType.isNovelType(activity.viewModel.getMangaReadingMode())

    private fun colorFilterPref(): Preference<Boolean> =
        if (isNovelDomain()) readerPreferences.novelColorFilter else preferences.colorFilter()

    private fun colorFilterValuePref(): Preference<Int> =
        if (isNovelDomain()) readerPreferences.novelColorFilterValue else preferences.colorFilterValue()

    private fun colorFilterModePref(): Preference<Int> =
        if (isNovelDomain()) readerPreferences.novelColorFilterMode else preferences.colorFilterMode()

    private fun customBrightnessPref(): Preference<Boolean> =
        if (isNovelDomain()) readerPreferences.novelCustomBrightness else preferences.customBrightness()

    private fun customBrightnessValuePref(): Preference<Int> =
        if (isNovelDomain()) readerPreferences.novelCustomBrightnessValue else preferences.customBrightnessValue()

    private fun grayscalePref(): Preference<Boolean> =
        if (isNovelDomain()) readerPreferences.novelGrayscale else preferences.grayscale()

    private fun invertedColorsPref(): Preference<Boolean> =
        if (isNovelDomain()) readerPreferences.novelInvertedColors else preferences.invertedColors()

    fun getAlphaFromColor(color: Int): Int = color shr 24 and 0xFF
    fun getRedFromColor(color: Int): Int = color shr 16 and 0xFF
    fun getBlueFromColor(color: Int): Int = color and 0xFF

    private companion object {
        const val ALPHA_MASK: Long = 0xFF000000
        const val RED_MASK: Long = 0x00FF0000
        const val GREEN_MASK: Long = 0x0000FF00
        const val BLUE_MASK: Long = 0x000000FF
    }
}

fun ReaderFilterView.getGreenFromColor(color: Int): Int = color shr 8 and 0xFF

@Composable
private fun ColorSliderRow(
    label: String,
    value: Float,
    enabled: Boolean,
    onValueChange: (Float) -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = if (enabled) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            modifier = Modifier.width(20.dp),
        )
        Slider(
            value = value,
            onValueChange = onValueChange,
            valueRange = 0f..255f,
            enabled = enabled,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 8.dp),
        )
        Text(
            text = value.roundToInt().toString(),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(36.dp),
        )
    }
}
