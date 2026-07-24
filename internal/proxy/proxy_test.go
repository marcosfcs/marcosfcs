package proxy

import "testing"

func TestToProxyPath(t *testing.T) {
	got := toProxyPath("https://cdn.example.com/path/seg.ts?a=1&b=2")
	want := "/p/https/cdn.example.com/path/seg.ts?a=1&b=2"
	if got != want {
		t.Fatalf("toProxyPath() = %q, want %q", got, want)
	}
}

func TestRewriteM3U8(t *testing.T) {
	in := `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,URI="https://cdn.example.com/audio.m3u8"
https://cdn.example.com/video/720p.m3u8
relative/segment.m3u8
#EXT-X-ENDLIST`
	want := `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,URI="/p/https/cdn.example.com/audio.m3u8"
/p/https/cdn.example.com/video/720p.m3u8
relative/segment.m3u8
#EXT-X-ENDLIST`
	got := rewriteM3U8(in)
	if got != want {
		t.Fatalf("rewriteM3U8() =\n%s\nwant\n%s", got, want)
	}
}

func TestRewriteMPD(t *testing.T) {
	in := `<MPD><BaseURL>https://cdn.example.com/</BaseURL>` +
		`<SegmentTemplate media="https://cdn.example.com/$Number$.m4s" initialization="https://cdn.example.com/init.mp4" /></MPD>`
	want := `<MPD><BaseURL>/p/https/cdn.example.com/</BaseURL>` +
		`<SegmentTemplate media="/p/https/cdn.example.com/$Number$.m4s" initialization="/p/https/cdn.example.com/init.mp4" /></MPD>`
	got := rewriteMPD(in)
	if got != want {
		t.Fatalf("rewriteMPD() =\n%s\nwant\n%s", got, want)
	}
}

func TestIsM3U8AndIsMPD(t *testing.T) {
	if !isM3U8("http://x/y.m3u8", "") {
		t.Fatal("esperava detectar .m3u8 pela extensão")
	}
	if !isM3U8("http://x/y", "application/vnd.apple.mpegurl") {
		t.Fatal("esperava detectar m3u8 pelo content-type")
	}
	if !isMPD("http://x/y.mpd", "") {
		t.Fatal("esperava detectar .mpd pela extensão")
	}
	if !isMPD("http://x/y", "application/dash+xml") {
		t.Fatal("esperava detectar mpd pelo content-type")
	}
	if isM3U8("http://x/y.mpd", "application/dash+xml") {
		t.Fatal("não deveria detectar m3u8 num alvo mpd")
	}
}
