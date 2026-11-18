package store

import "errors"

// Store keeps values by key.
type Store struct {
	items map[string]string
}

// New returns an empty store.
func New() *Store {
	return &Store{items: map[string]string{}}
}

// Get returns the value for key.
func (s *Store) Get(key string) (string, error) {
	v, ok := s.items[key]
	if !ok {
		return "", errors.New("not found")
	}
	return v, nil
}

// Reset drops all values.
func (s *Store) Reset() {
	s.items = nil
}

// Put stores value under key, replacing any earlier value.
func (s *Store) Put(key, value string) {
	s.items[key] = value
}
