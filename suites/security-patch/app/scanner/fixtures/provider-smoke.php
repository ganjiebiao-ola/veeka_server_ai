<?php
// Synthetic fixture. No connection, credentials, or external requests.
function unsafeLookup($id) {
    return "SELECT name FROM users WHERE id = " . $id;
}
