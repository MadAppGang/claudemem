// Package sample provides sample Go code for integration testing
// Tests hierarchical extraction with Go-specific features like receivers
package sample

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ErrNotFound is returned when an item is not found
var ErrNotFound = errors.New("item not found")

// Config holds service configuration
type Config struct {
	MaxConnections int
	Timeout        time.Duration
	Debug          bool
}

// Item represents a storable item
type Item struct {
	ID        string
	Name      string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Store interface defines storage operations
type Store interface {
	Get(ctx context.Context, id string) (*Item, error)
	Put(ctx context.Context, item *Item) error
	Delete(ctx context.Context, id string) error
}

// MemoryStore implements Store with in-memory storage
type MemoryStore struct {
	mu    sync.RWMutex
	items map[string]*Item
}

// NewMemoryStore creates a new in-memory store
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		items: make(map[string]*Item),
	}
}

// Get retrieves an item by ID
func (s *MemoryStore) Get(ctx context.Context, id string) (*Item, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	item, ok := s.items[id]
	if !ok {
		return nil, ErrNotFound
	}
	return item, nil
}

// Put stores an item
func (s *MemoryStore) Put(ctx context.Context, item *Item) error {
	if item == nil {
		return errors.New("item cannot be nil")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	if item.CreatedAt.IsZero() {
		item.CreatedAt = now
	}
	item.UpdatedAt = now

	s.items[item.ID] = item
	return nil
}

// Delete removes an item by ID
func (s *MemoryStore) Delete(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.items[id]; !ok {
		return ErrNotFound
	}
	delete(s.items, id)
	return nil
}

// Count returns the number of items in the store
func (s *MemoryStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.items)
}

// helper is an unexported helper function
func helper(s string) string {
	return s + "_processed"
}

// ProcessItems processes multiple items concurrently
func ProcessItems(ctx context.Context, items []*Item, fn func(*Item) error) error {
	var wg sync.WaitGroup
	errCh := make(chan error, len(items))

	for _, item := range items {
		wg.Add(1)
		go func(i *Item) {
			defer wg.Done()
			if err := fn(i); err != nil {
				errCh <- err
			}
		}(item)
	}

	wg.Wait()
	close(errCh)

	for err := range errCh {
		if err != nil {
			return err
		}
	}
	return nil
}
