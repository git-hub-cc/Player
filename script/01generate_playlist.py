import os
import json
from mutagen.id3 import ID3, APIC
from mutagen.mp3 import MP3
from mutagen.flac import FLAC
from mutagen.easyid3 import EasyID3

# --- Configuration ---
MUSIC_DIR = 'music'
VIDEO_DIR = 'videos'
ALBUM_ART_DIR = 'albumArt'
PLAYLIST_FILE = 'playlist.json'

# --- Audio Default Configuration ---
DEFAULT_AUDIO_ARTIST = 'Unknown Artist'
DEFAULT_ART_BASE_NAME = 'defaultArt'

# --- Video Default Configuration (新增) ---
VIDEO_TITLE_BASE = 'video_title'
VIDEO_ARTIST_BASE = 'video_artist'


def get_audio_metadata(filepath):
    """Extracts title and artist from an audio file."""
    try:
        audio = EasyID3(filepath)
        title = audio['title'][0] if 'title' in audio else None
        artist = audio['artist'][0] if 'artist' in audio else None
        return title, artist
    except Exception:
        return None, None

def extract_album_art(filepath, filename_base):
    """Extracts embedded album art and saves it to the albumArt directory."""
    try:
        if filepath.lower().endswith('.mp3'):
            audio = MP3(filepath, ID3=ID3)
            for tag in audio.tags.values():
                if isinstance(tag, APIC):
                    art_data = tag.data
                    ext = tag.mime.split('/')[-1]
                    if ext == 'jpeg': ext = 'jpg'
                    art_filename = f"{filename_base}.{ext}"
                    art_path = os.path.join(ALBUM_ART_DIR, art_filename)
                    with open(art_path, 'wb') as img_file:
                        img_file.write(art_data)
                    return art_path.replace(os.sep, '/')
    except Exception as e:
        print(f"  - Could not extract art from {os.path.basename(filepath)}: {e}")
    return ""

def main():
    """Main function to generate the playlist.json."""
    if not os.path.exists(ALBUM_ART_DIR):
        print(f"Creating directory: {ALBUM_ART_DIR}")
        os.makedirs(ALBUM_ART_DIR)

    new_playlist = []
    # **修改**: 为音频和视频设置独立的计数器
    audio_default_counter = 1
    video_counter = 1

    # --- Process Audio Files ---
    print(f"\nProcessing audio files from '{MUSIC_DIR}'...")
    if not os.path.exists(MUSIC_DIR):
        print(f"Warning: Music directory '{MUSIC_DIR}' not found.")
    else:
        for filename in sorted(os.listdir(MUSIC_DIR)):
            filepath = os.path.join(MUSIC_DIR, filename)
            if os.path.isfile(filepath):
                print(f"Processing: {filename}")
                filename_base, _ = os.path.splitext(filename)

                title, artist = get_audio_metadata(filepath)
                album_art = extract_album_art(filepath, filename_base)

                title = title or filename_base.replace('[SPOTDOWNLOADER.COM] ', '')

                # 音频文件的逻辑保持不变：为空时填充默认值
                if not artist:
                    artist = f"{DEFAULT_AUDIO_ARTIST}_{audio_default_counter:03d}"
                    audio_default_counter += 1

                if not album_art:
                    album_art = f"{DEFAULT_ART_BASE_NAME}{audio_default_counter:03d}"
                    audio_default_counter += 1

                track_info = {
                    "type": "audio",
                    "src": os.path.join(MUSIC_DIR, filename).replace(os.sep, '/'),
                    "title": title,
                    "artist": artist,
                    "albumArt": album_art,
                    "lyrics": ""
                }
                new_playlist.append(track_info)

    # --- Process Video Files ---
    print(f"\nProcessing video files from '{VIDEO_DIR}'...")
    if not os.path.exists(VIDEO_DIR):
        print(f"Warning: Video directory '{VIDEO_DIR}' not found.")
    else:
        for filename in sorted(os.listdir(VIDEO_DIR)):
            filepath = os.path.join(VIDEO_DIR, filename)
            if os.path.isfile(filepath) and filename.lower().endswith('.mp4'):
                print(f"Processing: {filename}")

                # **修改**: 根据新规则为视频生成 title, artist, 并将 albumArt 设为空
                video_title = f"{VIDEO_TITLE_BASE}_{video_counter:03d}"
                video_artist = f"{VIDEO_ARTIST_BASE}_{video_counter:03d}"

                track_info = {
                    "type": "video",
                    "src": os.path.join(VIDEO_DIR, filename).replace(os.sep, '/'),
                    "title": video_title,
                    "artist": video_artist,
                    "albumArt": "",  # albumArt 留空
                    "lyrics": ""
                }
                new_playlist.append(track_info)
                # 递增视频计数器
                video_counter += 1

    # --- Write new playlist.json ---
    with open(PLAYLIST_FILE, 'w', encoding='utf-8') as f:
        json.dump(new_playlist, f, indent=2, ensure_ascii=False)

    print(f"\nSuccessfully generated '{PLAYLIST_FILE}' with {len(new_playlist)} entries.")


if __name__ == '__main__':
    main()