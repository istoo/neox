import ExpoModulesCore

public class NeolixTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NeolixTerminal")

    View(NeolixTerminalView.self) {
      Events("onCellMetrics")

      Prop("frame") { (view: NeolixTerminalView, frame: TerminalFrameRecord) in view.setFrame(frame) }
      Prop("theme") { (view: NeolixTerminalView, theme: TerminalThemeRecord) in view.setTheme(theme) }
      Prop("fontFamily") { (view: NeolixTerminalView, family: String) in view.setFontFamily(family) }
      Prop("fontSize") { (view: NeolixTerminalView, size: Double) in view.setFontSize(size) }
      Prop("customGlyphs") { (view: NeolixTerminalView, glyphs: [TerminalCustomGlyphRecord]) in
        view.setCustomGlyphs(glyphs)
      }

      OnViewDidUpdateProps { (view: NeolixTerminalView) in view.commit() }
    }
  }
}
