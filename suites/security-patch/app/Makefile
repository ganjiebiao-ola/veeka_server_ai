.PHONY: dev-backend dev-frontend test test-backend check

dev-backend:
	cd backend && bun run dev

dev-frontend:
	cd frontend && bun run dev

test-backend:
	cd backend && bun run test

test: test-backend

check:
	cd backend && bun run check
	cd frontend && bun run typecheck
