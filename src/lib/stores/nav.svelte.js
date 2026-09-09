function createNavState() {
  let open = $state(false);
  return {
    get open() { return open; },
    openDrawer() { open = true; },
    closeDrawer() { open = false; }
  };
}

export const navState = createNavState();
