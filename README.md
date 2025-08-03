# Player - A Highly Customizable Modern Media Player

https://github.com/user-attachments/assets/33046049-a997-47e6-85e5-f4626889c0f0

## Introduction

This is a modern, feature-rich media player project built with HTML5, CSS, and vanilla JavaScript (ES6+). **Its interface is heavily inspired by Spotify and JIEJOE**, aiming to provide a beautiful, responsive, and user-friendly interface for playing local or online audio and video files. The project is built without any front-end frameworks (like React or Vue), showcasing the power of native web technologies.

## ✨ Features

- **Modern UI Design**: Inspired by Spotify and JIEJOE, the interface offers a clean, intuitive user experience, complete with a loading skeleton screen to enhance perceived performance.
- **Hybrid Media Support**: Seamlessly play audio (e.g., MP3) and video (e.g., MP4) files, with the UI automatically adapting to the media type.
- **Dynamic Playlist**: Easily manage and load your media queue via a `playlist.json` file.
- **Smart Playlist Search**: Supports fuzzy search in the playlist panel by title, artist, **Pinyin**, or **Pinyin initials** for Chinese characters.
- **ID3 Tag Reading**: Automatically extracts cover art, title, and artist information from MP3 files using `jsmediatags`, reducing manual configuration.
- **Dynamic UI Background**: When playing audio, the background intelligently extracts the theme color from the album art to generate a smooth gradient. For video, the video itself becomes the visual background.
- **Synchronized Lyrics Display**: Supports LRC format lyrics, which auto-scroll and highlight the current line during playback.
- **Multiple Playback Modes**: Easily switch between list loop, single loop, and shuffle modes with a single click.
- **Feature Tour**: A guided tour automatically triggers for first-time visitors, using highlights and tooltips to introduce core functionalities.
- **Highly Customizable Hotkeys**: A dedicated settings panel allows users to record and modify their own keyboard shortcuts for common actions like play/pause, next track, volume control, etc.
- **Immersive Mode**: Enter a full-screen, distraction-free viewing/listening experience with a single click.
- **Right-Click Context Menu**: Access core playback controls quickly by right-clicking anywhere on the page.
- **Integrated Media Downloader (Optional)**: When run with the Node.js backend, it can parse and download media from supported online platforms (e.g., Douyin).
- **Fully Responsive Design**: Provides an optimized layout and interaction experience on both wide-screen desktop browsers and mobile devices.
- **Slide-out Panel System**: Features like the playlist, about info, and hotkey settings are neatly tucked away in side panels to keep the main interface clean.

## 🚀 Quick Start

This project can be run in two ways: a front-end-only mode for core playback features, or with a full Node.js backend to enable advanced features like media downloading.

### Option 1: Run the Front-End Player Only (Basic Features)

This method is for quickly experiencing the player's UI and local playlist functionality.

1.  **Clone or download the project**
    ```bash
    git clone https://github.com/git-hub-cc/Player.git
    cd Player
    ```

2.  **Prepare Front-End Dependencies**
    The front-end relies on `pinyin-pro` for Pinyin search. Please download the library and place it in the `lib` folder.
    - [pinyin-pro download link](https://github.com/zh-lx/pinyin-pro)
    - Ensure the file path is `lib/index.min.js`

3.  **Start a Local Static Server**
    Due to browser security policies (CORS), opening `index.html` directly via the `file://` protocol will prevent features like fetching the playlist from working. You need a simple local server.

    - **Using `live-server` (Recommended)**:
      ```bash
      # Install live-server globally if you haven't already
      npm install -g live-server
      
      # Run from the project root directory
      live-server
      ```
    - **Using Python's built-in server**:
      ```bash
      # Python 3
      python -m http.server
      
      # Python 2
      python -m SimpleHTTPServer
      ```
    Then, open the address provided by the server in your browser (e.g., `http://127.0.0.1:8080`).

### Option 2: Run the Full Back-End Service (with Advanced Features)

This method starts a Node.js server that supports all front-end features plus server-side capabilities like media downloading.

**Prerequisites**: Ensure you have [Node.js](https://nodejs.org/) (LTS version recommended) installed on your system.

1.  **Clone the project and navigate into it**
    ```bash
    git clone https://github.com/git-hub-cc/Player.git
    cd Player
    ```

2.  **Prepare Front-End Dependencies**
    Same as in Option 1, ensure `pinyin-pro` is located at `lib/index.min.js`.

3.  **Install Back-End Dependencies**
    In the project's root directory, open your terminal and run the following command to install required libraries for the server (like `playwright`, `axios`, etc.):
    ```bash
    npm install playwright axios cli-progress
    ```
    This will install the dependencies into a `node_modules` folder.

4.  **Install Playwright Browsers (Crucial Step!)**
    Playwright needs to download the browser binaries it uses for automation. **Do not skip this step**, or the download feature will fail.
    ```bash
    npx playwright install
    ```
    This process might take some time, depending on your internet connection.

5.  **Start the Back-End Server**
    Once all dependencies are installed, run the following command to start the server:
    ```bash
    node server.js
    ```

6.  **Access the Application**
    After the server starts, open `http://localhost:3000` (or the address shown in the terminal) in your browser. You can now use all features, including the media downloader.


## 🔧 Configuration

### Playlist (`playlist.json`)
You can manage your media content by editing the `playlist.json` file in the project root. The file is a JSON array where each object represents a media track.

**Track Object Structure:**

| Key        | Type   | Description                                                                                                   | Required |
|------------|--------|---------------------------------------------------------------------------------------------------------------|----------|
| `title`    | string | The title of the media.                                                                                       | Yes      |
| `artist`   | string | The artist or creator.                                                                                        | Yes      |
| `src`      | string | The path to the media file (local relative path or URL).                                                      | Yes      |
| `type`     | string | The media type, either `'audio'` or `'video'`.                                                                | Yes      |
| `lyrics`   | string | LRC format lyrics text. If left empty, "No lyrics available" will be displayed.                                 | No       |
| `albumArt` | string | URL of the cover art. For audio files, if this is not provided, the system will try to read it from metadata. | No       |

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

## 🛠️ Technology Stack

- **Core**: HTML5, CSS3, JavaScript (ES6+, Modules)
- **Front-End Libraries**:
    - [jsmediatags.js](https://github.com/aadsm/jsmediatags): For reading ID3 metadata from MP3 files on the client-side.
    - [pinyin-pro](https://github.com/zh-lx/pinyin-pro): For powerful Chinese Pinyin search functionality.
- **Back-End Service (Optional)**:
    - **Environment**: Node.js
    - **Libraries**:
        - [Playwright](https://playwright.dev/): For browser automation to parse media resources.
        - [Axios](https://axios-http.com/): For making HTTP requests.
        - [cli-progress](https://github.com/AndiDittrich/Node.CLI-Progress): For displaying elegant progress bars in the command line.

## 📄 Resources and Copyright Notice

**Important Notice**: All media resources used in this project (including but not limited to audio and video files) are collected from the internet for learning and technical demonstration purposes only. They are not intended for any commercial use.

Specific sources of media include:
- **Online Platforms**: Douyin, Spotify
- **Artists/Creators**: e.g., Wang Zai Xiao Qiao, Yin Yisi¹²¹² (Dali version)
- **Tools**: SPOTDOWNLOADER

The copyright of all media content belongs to the original authors or their respective copyright holders. If you are the copyright owner of any media content and believe its use in this project constitutes an infringement of your rights, please contact us, and we will remove the relevant content immediately.

## Acknowledgements

- **Spotify**: For its modern, beautiful, and user-friendly design, which served as the primary UI/UX inspiration for this project.
- The open-source community for providing excellent tools like `jsmediatags` and `pinyin-pro`.