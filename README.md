### Open DART API key via .env

- Copy `.env.example` to `.env`
- Set your key value:

```env
OPEN_DART_API_KEY=YOUR_OPEN_DART_API_KEY
```

- `.env` is ignored by Git; commit `.env.example`.

### Usage

- Node.js (dotenv):
```js
require('dotenv').config();
const apiKey = process.env.OPEN_DART_API_KEY;
```

- Python (python-dotenv):
```python
from dotenv import load_dotenv
import os
load_dotenv()
api_key = os.getenv('OPEN_DART_API_KEY')
```

- Flutter/Dart (flutter_dotenv):
  - Add dependency: `flutter pub add flutter_dotenv`
  - Add to `pubspec.yaml` assets:
```yaml
flutter:
  assets:
    - .env
```
  - Initialize and read:
```dart
import 'package:flutter_dotenv/flutter_dotenv.dart';

Future<void> main() async {
  await dotenv.load(fileName: ".env");
  final apiKey = dotenv.env['OPEN_DART_API_KEY'];
}
```

Note: In client apps (e.g., Flutter), `.env` is bundled in the app; avoid storing secrets you cannot ship.

### Dart (server/CLI) usage

- Add dependency: `dart pub add dotenv`
- Create `.env` from the example and set your key
- Load and read in Dart:
```dart
import 'package:dotenv/dotenv.dart' as dotenv;

void main() {
  final env = dotenv.DotEnv(includePlatformEnvironment: true)..load();
  final apiKey = env['OPEN_DART_API_KEY'];
  print('OPEN_DART_API_KEY: $apiKey');
}
```

### Run the web app

1) Install deps: `npm install`
2) Seed DB from XML: `node scripts/seed_corpcode.js`
3) Start server: `node server.js` (or `npx nodemon server.js`)
4) Open: `http://localhost:3000` and search companies, fetch, visualize