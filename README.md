# Player - A Highly Customizable Modern Media Player

https://github.com/user-attachments/assets/33046049-a997-47e6-85e5-f4626889c0f0

## Introduction

This is a modern, feature-rich media player project built with HTML5, CSS, and vanilla JavaScript (ES6+). **Its interface is heavily inspired by Spotify**, aiming to provide a beautiful, responsive, and user-friendly interface for playing local or online audio and video files. The project is built without any frontend frameworks (like React or Vue), showcasing the power of native web technologies.

## ✨ Feature Highlights

-   **Modern UI Design**: An interface inspired by Spotify, providing a clean and intuitive user experience, complete with a skeleton loading screen to enhance the initial load.
-   **Hybrid Media Support**: Seamlessly play both audio (e.g., MP3) and video (e.g., MP4) files, with the UI automatically adapting to the media type.
-   **Dynamic Playlist**: Easily manage and load your media queue through a simple `playlist.json` file.
-   **Smart Playlist Search**: The playlist panel supports fuzzy search by title, artist, **Pinyin**, or **Pinyin initials**.
-   **ID3 Tag Reading**: Utilizes `jsmediatags` to automatically extract cover art, title, and artist information from MP3 files, minimizing manual configuration.
-   **Dynamic UI Background**: For audio playback, it intelligently extracts dominant colors from the album art to generate a smooth, elegant gradient background. For video playback, the video itself becomes the visual background.
-   **Synchronized Lyrics**: Supports the LRC format for lyrics, which automatically scroll and highlight the current line during playback.
-   **Multiple Play Modes**: Easily switch between List Loop, Single Loop, and Shuffle modes with a single click.
-   **Feature Tour**: First-time visitors are greeted with a guided tour that highlights key features, helping them get started quickly.
-   **Highly Customizable Shortcuts**: A dedicated settings panel allows users to record and modify their own keyboard shortcuts for common actions like play/pause, next track, volume control, and more.
-   **Immersive Mode**: Enter a one-click fullscreen mode for an immersive, distraction-free listening or viewing experience.
-   **Right-Click Context Menu**: Right-click anywhere on the page to quickly access core playback controls.
-   **Fully Responsive Design**: Delivers an optimized layout and interaction experience on both widescreen desktop browsers and mobile devices.
-   **Side Panel System**: Organizes the playlist, "About" information, and shortcut settings into clean, retractable side panels, keeping the main interface uncluttered.

## 🚀 Quick Start

1.  **Clone or Download the Project**
    ```bash
    git clone https://github.com/git-hub-cc/Player.git
    cd Player
    ```

2.  **Set Up Dependencies**
    This project relies on `pinyin-pro` for its advanced Chinese Pinyin search functionality. Please download the library and place it in the `lib` folder.
    -   [pinyin-pro download link](https://github.com/zh-lx/pinyin-pro)
    -   Ensure the file path is `lib/index.min.js`.

3.  **Start a Local Server**
    Due to browser security policies (CORS), opening `index.html` directly via the `file://` protocol may prevent some features (like fetching `playlist.json`) from working. It's recommended to use a simple local server.

    If you have Node.js installed, you can use `http-server` or `live-server`:
    ```bash
    # Install live-server globally (if you haven't already)
    npm install -g live-server
    
    # Run from the project's root directory
    live-server
    ```
    Alternatively, use Python's built-in HTTP server:
    ```bash
    # For Python 3
    python -m http.server
    
    # For Python 2
    python -m SimpleHTTPServer
    ```
    Then, open the provided address (e.g., `http://127.0.0.1:8080`) in your browser.

## 🔧 How to Configure

### The Playlist (`playlist.json`)
You can manage your media content by editing the `playlist.json` file in the project's root directory. The file is a JSON array, where each object represents a media track.

**Track Object Structure:**

| Key        | Type   | Description                                                                                              | Required |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------- | -------- |
| `title`    | string | The title of the media.                                                                                  | Yes      |
| `artist`   | string | The artist or creator.                                                                                   | Yes      |
| `src`      | string | The path to the media file (relative local path or URL).                                                 | Yes      |
| `type`     | string | The media type, either `'audio'` or `'video'`.                                                           | Yes      |
| `lyrics`   | string | LRC-formatted lyrics text. If left empty, "No lyrics available" will be displayed.                         | No       |
| `albumArt` | string | The URL for the cover art. For audio files, if this is not provided, the system will try to read it from the file's metadata using `jsmediatags`. | No       |

**Example:**
```json
[
  {
    "title": "Song A",
    "artist": "Artist A",
    "src": "media/audio/song_a.mp3",
    "type": "audio",
    "lyrics": "[00:01.00]First line of lyrics\n[00:05.50]Second line of lyrics",
    "albumArt": "media/art/album_a.jpg"
  },
  {
    "title": "Video B",
    "artist": "Creator B",
    "src": "media/video/video_b.mp4",
    "type": "video",
    "lyrics": ""
  }
]
```

## 🛠️ Tech Stack

-   **Core**: HTML5, CSS3, JavaScript (ES6+, Modules)
-   **Libraries**:
    -   [jsmediatags.js](https://github.com/aadsm/jsmediatags): For reading ID3 metadata from MP3 files on the client-side.
    -   [pinyin-pro](https://github.com/zh-lx/pinyin-pro): For implementing powerful Chinese Pinyin search functionality.

## 📄 Resource and Copyright Notice

**Important Notice**: All media resources (including but not limited to audio and video files) used in this project are collected from the internet and are intended for learning and technical demonstration purposes only. They are not for commercial use.

Specific sources for the media include:
-   **Online Platforms**: TikTok (Douyin), Spotify
-   **Artists/Creators**: 旺仔小乔, 尹懿思¹²¹²（大力版）
-   **Tools**: SPOTDOWNLOADER

The copyright for all media content belongs to the original authors or their respective copyright holders. If you are the copyright owner of any media content and believe that its use in this project infringes upon your rights, please contact us, and we will remove the content immediately.

## Acknowledgements

-   **Spotify**: For providing the primary UI/UX design inspiration with its modern, beautiful, and user-friendly interface.
-   The open-source community for providing excellent tools like `jsmediatags` and `pinyin-pro`.