package store

import "testing"

func TestPutGet(t *testing.T) {
	s := New()
	s.Put("a", "1")
	if v, _ := s.Get("a"); v != "1" {
		t.Fatalf("got %q", v)
	}
}
