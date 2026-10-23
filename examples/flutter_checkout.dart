// Add http and url_launcher to your Flutter project's pubspec.yaml.
// YOUR backend endpoint must authenticate the customer and calculate the order amount.
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

Future<void> openCashierCheckout({
  required Uri backend,
  required String userAccessToken,
  required String orderId,
}) async {
  final response = await http.post(
    backend.resolve('/orders/$orderId/payment'),
    headers: {
      'Authorization': 'Bearer $userAccessToken',
      'Content-Type': 'application/json',
    },
    body: jsonEncode({'method': 'qr'}),
  );
  if (response.statusCode != 200 && response.statusCode != 201) {
    throw Exception('Не удалось создать оплату');
  }
  final result = jsonDecode(response.body) as Map<String, dynamic>;
  final checkout = Uri.parse(result['checkout_url'] as String);
  // Your backend must return only your configured HTTPS cashier origin.
  if (checkout.scheme != 'https') throw Exception('Небезопасная ссылка оплаты');
  if (!await launchUrl(checkout, mode: LaunchMode.externalApplication)) {
    throw Exception('Не удалось открыть оплату');
  }
  // On app resume, query your backend order status. Opening or returning from
  // this URL is NOT proof of payment. Only your backend confirms the order.
}
