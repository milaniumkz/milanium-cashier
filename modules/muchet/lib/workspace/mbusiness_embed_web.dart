// This message contains no session token. The parent validates origin/source.
import 'dart:html' as html;
void openMBusinessSettings() {
  html.window.parent?.postMessage({'type':'mbusiness-settings'}, html.window.location.origin);
}
