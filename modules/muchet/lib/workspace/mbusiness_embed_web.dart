// No token is included in parent messages. Both sides validate origin/source.
import 'dart:html' as html;
import 'dart:js_util' as js_util;
void openMBusinessSettings() {
  html.window.parent?.postMessage({'type':'mbusiness-settings'}, html.window.location.origin);
}
void notifyMBusinessAccountingReady(bool ready, [String? error]) {
  html.window.parent?.postMessage({'type':'mbusiness-accounting-state','ready':ready,'error':error}, html.window.location.origin);
}
void Function() watchMBusinessSection(void Function(String) onSection) {
  final subscription=html.window.onMessage.listen((event){
    if(event.origin!=html.window.location.origin || !identical(js_util.getProperty<Object?>(event,'source'),js_util.getProperty<Object?>(html.window,'parent'))) return;
    final data=event.data;
    if(data is Map && data['type']=='mbusiness-accounting-section' && data['section'] is String) onSection(data['section'] as String);
  });
  return () { subscription.cancel(); };
}
