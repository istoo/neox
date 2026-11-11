package com.istoo.neox.terminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NeolixTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NeolixTerminal")

    View(NeolixTerminalView::class) {
      Events("onCellMetrics")

      Prop("frame") { view: NeolixTerminalView, frame: TerminalFrameRecord -> view.setFrame(frame) }
      Prop("theme") { view: NeolixTerminalView, theme: TerminalThemeRecord -> view.setTheme(theme) }
      Prop("fontFamily") { view: NeolixTerminalView, family: String -> view.setFontFamily(family) }
      Prop("fontSize") { view: NeolixTerminalView, size: Double -> view.setFontSize(size) }
      Prop("customGlyphs") { view: NeolixTerminalView, glyphs: List<TerminalCustomGlyphRecord> ->
        view.setCustomGlyphs(glyphs)
      }

      OnViewDidUpdateProps { view: NeolixTerminalView -> view.commit() }
    }
  }
}
